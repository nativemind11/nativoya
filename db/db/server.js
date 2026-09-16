require("dotenv").config();
const express = require("express");
const cors = require("cors");

const authRoutes = require("./routes/auth");
const groupsRoutes = require("./routes/groups");
const tasksRoutes = require("./routes/tasks");
const paymentsRoutes = require("./routes/payments");

const app = express();

app.use(cors({ origin: process.env.FRONTEND_URL || "*" }));
app.use(express.json());

app.get("/", (req, res) => res.json({ status: "ok", service: "Nativoya API" }));
app.get("/health", (req, res) => res.json({ status: "healthy", time: new Date().toISOString() }));

app.use("/api/auth", authRoutes);
app.use("/api/groups", groupsRoutes);
app.use("/api/tasks", tasksRoutes);
app.use("/api/payments", paymentsRoutes);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

if (require.main === module) {
  const PORT = process.env.PORT || 4000;
  app.listen(PORT, () => console.log(`Nativoya API listening on port ${PORT}`));
}

module.exports = app;
