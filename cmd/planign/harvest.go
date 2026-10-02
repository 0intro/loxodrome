// harvest.go runs the fetch: every wanted tile the cache does not already
// answer for, through a fixed pool of workers, then once more, slowly, for
// the tiles that failed. A harvest either resolves every tile or fails and
// keeps what it got: an archive with holes would be served to every pilot
// as though it were the map.

package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"sync"
	"sync/atomic"
	"time"
)

// secondPassDelay is the pause before the failed tiles are asked again: a
// var so the tests need not wait.
var secondPassDelay = 30 * time.Second

// counts is the harvest's running tally.
type counts struct {
	present, absent, failed atomic.Int64
}

// harvestPass fetches todo with concurrency workers. It returns the tiles
// that failed after their retries, or the error that stopped it: a
// *fatalError, the breaker, or the context (a deadline, an interrupt).
func harvestPass(ctx context.Context, f *fetcher, c *cache, todo []tile, concurrency int, progress time.Duration) ([]tile, error) {
	ctx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)

	var (
		tally   counts
		br      breaker
		mu      sync.Mutex
		failed  []tile
		done    atomic.Int64
		started = time.Now()
	)
	jobs := make(chan tile)
	var wg sync.WaitGroup
	for range concurrency {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for t := range jobs {
				ok, err := harvestOne(ctx, f, c, t, &tally)
				done.Add(1)
				if err != nil {
					var fatal *fatalError
					if errors.As(err, &fatal) || ctx.Err() != nil {
						cancel(err)
						continue
					}
					log.Printf("%v", err)
					mu.Lock()
					failed = append(failed, t)
					mu.Unlock()
				}
				if berr := br.record(!ok && err != nil); berr != nil {
					cancel(fmt.Errorf("breaker: %w", berr))
				}
			}
		}()
	}

	stop := make(chan struct{})
	if progress > 0 {
		go func() {
			tick := time.NewTicker(progress)
			defer tick.Stop()
			for {
				select {
				case <-stop:
					return
				case <-tick.C:
					logProgress(done.Load(), int64(len(todo)), &tally, started)
				}
			}
		}()
	}

feed:
	for _, t := range todo {
		select {
		case jobs <- t:
		case <-ctx.Done():
			break feed
		}
	}
	close(jobs)
	wg.Wait()
	close(stop)
	logProgress(done.Load(), int64(len(todo)), &tally, started)

	// Nothing here cancels ctx on success (the deferred cancel runs after
	// the return), so a done context is always a stop: ours with its cause,
	// or the parent's deadline or interrupt, which leave tiles unfetched.
	if ctx.Err() != nil {
		return failed, context.Cause(ctx)
	}
	return failed, nil
}

// harvestOne fetches, encodes and caches one tile. ok is false for a tile
// that failed; err carries why.
func harvestOne(ctx context.Context, f *fetcher, c *cache, t tile, tally *counts) (bool, error) {
	body, err := f.get(ctx, t)
	if err != nil {
		// A request cut short by the run stopping is no failure of the tile.
		if ctx.Err() == nil {
			tally.failed.Add(1)
		}
		return false, err
	}
	if body == nil {
		if err := c.putNone(t); err != nil {
			return false, err
		}
		tally.absent.Add(1)
		return true, nil
	}
	e, err := encodeTile(body)
	if err != nil {
		tally.failed.Add(1)
		return false, fmt.Errorf("%s: %w", t, err)
	}
	if err := c.putTile(t, e); err != nil {
		return false, err
	}
	tally.present.Add(1)
	return true, nil
}

func logProgress(done, total int64, tally *counts, started time.Time) {
	elapsed := time.Since(started)
	rate := float64(done) / elapsed.Seconds()
	eta := "?"
	if rate > 0 {
		eta = (time.Duration(float64(total-done)/rate) * time.Second).Round(time.Minute).String()
	}
	log.Printf("%d/%d tiles (present %d, absent %d, failed %d) %.1f/s, about %s left",
		done, total, tally.present.Load(), tally.absent.Load(), tally.failed.Load(), rate, eta)
}

// harvestAll resolves every tile in want: the cache first, then one pass at
// full concurrency, then a slower pass over the failures. It returns
// errIncomplete wrapped with the count when tiles remain unresolved.
func harvestAll(ctx context.Context, f *fetcher, c *cache, want []tile, concurrency int) error {
	var todo []tile
	for _, t := range want {
		if !c.resolved(t) {
			todo = append(todo, t)
		}
	}
	log.Printf("%d tiles wanted, %d already in the cache, %d to fetch", len(want), len(want)-len(todo), len(todo))
	if len(todo) == 0 {
		return nil
	}
	failed, err := harvestPass(ctx, f, c, todo, concurrency, time.Minute)
	if err != nil {
		return err
	}
	if len(failed) > 0 {
		log.Printf("%d tiles failed; trying them again in %s, two at a time", len(failed), secondPassDelay)
		if err := sleepCtx(ctx, secondPassDelay); err != nil {
			return err
		}
		failed, err = harvestPass(ctx, f, c, failed, 2, 0)
		if err != nil {
			return err
		}
	}
	if len(failed) > 0 {
		return fmt.Errorf("%w: %d tiles unresolved (first %s); run again to retry them", errIncomplete, len(failed), failed[0])
	}
	return nil
}
