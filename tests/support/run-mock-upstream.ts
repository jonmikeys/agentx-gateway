import { startMockUpstream } from "./mock-upstream";

/** Runs the mock upstream for manual demos: `MOCK_UPSTREAM_PORT=4010 pnpm exec tsx tests/support/run-mock-upstream.ts`. */
const port = Number(process.env.MOCK_UPSTREAM_PORT ?? 4010);
const upstream = await startMockUpstream({ port });
console.log(`Mock upstream listening on ${upstream.url}`);
