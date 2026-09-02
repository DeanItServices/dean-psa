/**
 * WHICH SERVER THE SUITE GRADES -- resolved in exactly one place.
 *
 * This module is imported by playwright.config.ts AND by the global
 * setup/teardown hooks, so the runner, the browser contexts and the
 * build-identity check can never disagree about what they are pointed at.
 *
 * THE BUG THIS EXISTS TO CLOSE. The previous config hardcoded
 * `http://localhost:3000` for both `use.baseURL` and `webServer.url`, with
 * `reuseExistingServer: !process.env.CI`. On this machine port 3000 is held by
 * the `dean-psa-app-1` container running a PREVIOUSLY-BUILT image. Playwright
 * saw something answering on :3000, skipped starting a server, and graded that
 * container -- silently, with a green run. Measured directly, both servers up
 * at the same time:
 *
 *   container :3000  /login  ->  0 x "<h1"   0 x "<main"
 *   dev server :3100 /login  ->  1 x "<h1"   1 x "<main"
 *
 * (the <main> landmark and real <h1> are this review cycle's accessibility
 * work, so their absence is proof the container predates the code under test).
 * Every "pass" that run produced was a statement about an old build.
 *
 * THREE INDEPENDENT DEFENCES, because any one of them can be argued around:
 *
 *  1. A DIFFERENT DEFAULT PORT. 3100, not 3000, so the common case does not
 *     even reach for the port the container occupies.
 *  2. `reuseExistingServer: false` (see playwright.config.ts). Playwright now
 *     always starts its own server and FAILS LOUDLY if the port is busy,
 *     rather than adopting whatever is listening.
 *  3. A BUILD-IDENTITY CHECK in e2e/global-setup.ts, which runs before the
 *     first test and refuses a server that does not serve the current source.
 *     This is the one that also covers the escape hatch below.
 *
 * ESCAPE HATCH, deliberately explicit. Setting E2E_BASE_URL points the suite at
 * a server the caller manages (a container, a staging box, `next start` against
 * a production build) and suppresses `webServer` entirely -- it would be
 * actively wrong to start a second server in that case. That is the ONE way to
 * grade a foreign server, it takes a named environment variable to reach, and
 * defence 3 still runs against it.
 *
 * THE HATCH RETARGETS THE SERVER ONLY -- AND THAT IS HALF A SUITE. This module
 * decides what the BROWSER drives. It has never decided what the runner process
 * talks to: the Prisma client in e2e/db.ts resolves its connection string
 * independently, so E2E_BASE_URL on its own would leave every `readUserRow`,
 * the orphan sweep, the per-spec teardown and the seeded-fixture baseline/diff
 * pointed at the database in this working tree while the browser drove
 * something else. Half the suite's assertions read a database the graded server
 * never writes to, and the sweep deletes local accounts while leaving live ones
 * on the target.
 *
 * So the hatch is now a PAIR: setting E2E_BASE_URL requires E2E_DATABASE_URL,
 * and e2e/global-setup.ts refuses the run at once if only one is set
 * (resolveE2eDatabaseUrl in e2e/db.ts carries the full explanation and the
 * failure message). AUTH_SECRET is the same coupling one step further out and
 * is documented there.
 *
 * HOSTNAME IS "localhost", NOT "127.0.0.1", AND THAT IS LOAD-BEARING.
 * Next.js 16 dev blocks cross-origin requests for its own dev assets unless the
 * origin is listed in `allowedDevOrigins`. `next dev` announces itself on
 * `localhost`, so driving it as `http://127.0.0.1:PORT` makes every
 * /_next/static and /_next/hmr fetch a blocked cross-origin request. Observed
 * directly while building this suite: the page rendered, React never hydrated,
 * and the login form fell back to a NATIVE form submit -- which is a GET, so
 * the credentials landed in the query string and in the dev server's access
 * log. Do not "simplify" this to 127.0.0.1.
 */

/** Port the managed dev server listens on, and that baseURL points at. */
export const E2E_PORT = process.env.E2E_PORT ?? "3100";

/** True when the caller supplied their own server and owns its lifecycle. */
export const E2E_SERVER_IS_EXTERNAL = Boolean(process.env.E2E_BASE_URL);

/** The single origin every part of the suite talks to. */
export const E2E_BASE_URL =
  process.env.E2E_BASE_URL ?? `http://localhost:${E2E_PORT}`;
