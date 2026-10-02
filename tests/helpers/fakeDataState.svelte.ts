/* A stand-in for state/data.svelte's dataState, reactive, for specs that
 * mock the data module (tests/routeMemoRetry.client.spec.ts): the route MSA
 * reads the obstacles revision, and a spec bumps it to land a country. */

export const fakeDataState = $state({ revision: { obstacles: 0 } });
