// index.js — minimal starter
import express from "express";
import cors from "cors";
import morgan from "morgan";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(morgan("dev"));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "ds-backend", ts: new Date().toISOString() });
});

const PORT = parseInt(process.env.PORT || "3000", 10);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[DS] Listening on :${PORT}`);
});
<<<<<<< HEAD

=======
>>>>>>> 7487bde (Fix index.js syntax for Railway)
