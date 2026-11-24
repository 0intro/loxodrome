package aixm5build

import (
	"time"

	"github.com/0intro/loxodrome/internal/aixm5"
)

// testNow freezes the generatedAt stamp so metas compare byte for byte.
func testNow() time.Time { return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC) }

// obs is a terse literal for one obstacle in a builder test.
type obs struct {
	id     string
	typ    string
	height *float64
	lit    bool
}

func obstacleMessage(list ...obs) *aixm5.Message {
	msg := &aixm5.Message{}
	for _, o := range list {
		msg.Obstacles = append(msg.Obstacles, aixm5.Obstacle{
			ID:      o.id,
			Name:    o.id,
			Type:    o.typ,
			HeightM: o.height,
			Lighted: o.lit,
		})
	}
	return msg
}
