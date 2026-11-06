// server/deployInfo.ts
//
// Which commit this process is running, from the host's build variables. Pure.
// Railway sets RAILWAY_GIT_COMMIT_SHA for GitHub deploys; others are common
// CI/PaaS names. Unknown stays null: never guessed from the working tree.

export interface DeployInfo { commit: string | null; commitSource: string | null; branch: string | null }

const SHA = /^[0-9a-f]{7,40}$/i;

export function deployInfo(env: Record<string, string | undefined>): DeployInfo {
  for (const name of ["RAILWAY_GIT_COMMIT_SHA", "SOURCE_VERSION", "GIT_COMMIT", "COMMIT_SHA"]) {
    const v = (env[name] ?? "").trim();
    if (SHA.test(v)) {
      const branch = (env.RAILWAY_GIT_BRANCH ?? env.GIT_BRANCH ?? "").trim();
      return { commit: v.slice(0, 12).toLowerCase(), commitSource: name, branch: branch || null };
    }
  }
  return { commit: null, commitSource: null, branch: null };
}
