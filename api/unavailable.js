// Website-only Vercel deployment: there is no Batcave server behind this site
// yet (Schwab connection, stream, database and schedulers need an always-on
// host). Every /api call answers with the app's standard "unavailable"
// contract so each panel shows a clear state instead of a broken page.
export default function handler(_req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.status(503).json({
    error: "data_unavailable",
    dataState: "unavailable",
    reason: "No Batcave server is connected to this website yet.",
  });
}
