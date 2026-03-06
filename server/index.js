// todo-app/server/index.js
import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import nodemailer from "nodemailer";
import cron from "node-cron";
import { DateTime } from "luxon";

dotenv.config();

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  SMTP_SECURE,
  FROM_EMAIL,
  PORT,
  CORS_ORIGIN
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const app = express();
app.use(bodyParser.json());
app.use(cors({ origin: CORS_ORIGIN || true }));

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT ? Number(SMTP_PORT) : 587,
  secure: SMTP_SECURE === "true",
  auth: {
    user: SMTP_USER,
    pass: SMTP_PASS
  }
});

async function sendEmail(to, subject, html) {
  const mailOptions = {
    from: FROM_EMAIL || SMTP_USER,
    to,
    subject,
    html
  };
  return transporter.sendMail(mailOptions);
}

function escapeHtml(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatTaskList(tasks) {
  if (!tasks || tasks.length === 0) return "<p>No tasks.</p>";
  return `<ul>${tasks
    .map(
      (t) =>
        `<li style="margin-bottom:8px"><strong>${escapeHtml(t.title)}</strong>${t.description ? " — " + escapeHtml(t.description) : ""}${t.assigned_date ? ` <small>(${t.assigned_date})</small>` : ""}${t.completed ? " ✅" : ""}</li>`
    )
    .join("")}</ul>`;
}

// ---------------- API endpoints ----------------

// Create or upsert user
app.post("/api/users", async (req, res) => {
  const { email, full_name } = req.body;
  if (!email) return res.status(400).json({ error: "email required" });
  const { data, error } = await supabase
    .from("app_users")
    .upsert({ email, full_name }, { onConflict: "email" })
    .select()
    .single();
  if (error) return res.status(500).json({ error });
  res.json(data);
});

// Create a task and optionally assign to a date
app.post("/api/tasks", async (req, res) => {
  const { user_id, title, description, is_long_run = false, assign_date } = req.body;
  if (!user_id || !title) return res.status(400).json({ error: "user_id and title required" });

  const { data: task, error: tErr } = await supabase
    .from("tasks")
    .insert({ user_id, title, description, is_long_run })
    .select()
    .single();

  if (tErr) return res.status(500).json({ error: tErr });

  if (assign_date) {
    const { error: instErr } = await supabase.from("task_instances").upsert(
      { task_id: task.id, assigned_date: assign_date },
      { onConflict: "task_id,assigned_date" }
    );
    if (instErr) console.error("assign err", instErr);
  }

  res.json(task);
});

// Assign existing task to a date
app.post("/api/tasks/:taskId/assign", async (req, res) => {
  const { taskId } = req.params;
  const { assigned_date } = req.body;
  if (!assigned_date) return res.status(400).json({ error: "assigned_date required" });

  const { error } = await supabase.from("task_instances").upsert(
    { task_id: taskId, assigned_date },
    { onConflict: "task_id,assigned_date" }
  );
  if (error) return res.status(500).json({ error });
  res.json({ ok: true });
});

// Mark instance done/undone
app.post("/api/instances/:instanceId/complete", async (req, res) => {
  const { instanceId } = req.params;
  const { completed = true } = req.body;
  const updates = {
    completed,
    completed_at: completed ? new Date().toISOString() : null
  };
  const { data, error } = await supabase
    .from("task_instances")
    .update(updates)
    .eq("id", instanceId)
    .select()
    .single();

  if (error) return res.status(500).json({ error });

  await supabase.from("task_history").insert({
    task_instance_id: instanceId,
    action: completed ? "marked_done" : "marked_undone",
    info: {}
  });

  res.json(data);
});

// Edit task
app.put("/api/tasks/:taskId", async (req, res) => {
  const { taskId } = req.params;
  const payload = req.body;
  const { data, error } = await supabase
    .from("tasks")
    .update(payload)
    .eq("id", taskId)
    .select()
    .single();
  if (error) return res.status(500).json({ error });
  res.json(data);
});

// Get tasks for a user for a date (includes long-run)
app.get("/api/users/:userId/tasks", async (req, res) => {
  const { userId } = req.params;
  const { date } = req.query;
  const qdate = date || DateTime.now().setZone("Asia/Kolkata").toISODate();

  const { data: userTasks, error: tErr } = await supabase
    .from("tasks")
    .select("*")
    .eq("user_id", userId);
  if (tErr) return res.status(500).json({ error: tErr });

  const taskIds = (userTasks || []).map((t) => t.id);
  if (taskIds.length === 0) {
    return res.json({ date: qdate, instances: [], longRun: [] });
  }

  const { data: instances, error: iErr } = await supabase
    .from("task_instances")
    .select("*, tasks(*)")
    .eq("assigned_date", qdate)
    .in("task_id", taskIds);
  if (iErr) return res.status(500).json({ error: iErr });

  const { data: longRun, error: lErr } = await supabase
    .from("tasks")
    .select("*")
    .eq("user_id", userId)
    .eq("is_long_run", true);
  if (lErr) console.error(lErr);

  res.json({ date: qdate, instances: instances || [], longRun: longRun || [] });
});

// Manual triggers for testing (existing)
app.post("/api/run/morning", async (req, res) => {
  try {
    await morningJob();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post("/api/run/night", async (req, res) => {
  try {
    await nightJob();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- New endpoint: send a test email for a given user (mode = 'morning' | 'night' | 'both')
app.post("/api/send/test", async (req, res) => {
  try {
    const { user_id, mode = "morning" } = req.body;
    if (!user_id) return res.status(400).json({ error: "user_id required" });

    const { data: user, error: userErr } = await supabase
      .from("app_users")
      .select("*")
      .eq("id", user_id)
      .maybeSingle();

    if (userErr) return res.status(500).json({ error: userErr });
    if (!user) return res.status(404).json({ error: "user not found" });

    if (mode === "morning" || mode === "both") {
      await morningJobForUser(user);
    }
    if (mode === "night" || mode === "both") {
      await nightJobForUser(user);
    }

    res.json({ ok: true, sentTo: user.email, mode });
  } catch (e) {
    console.error("send/test error", e);
    res.status(500).json({ error: e.message });
  }
});

// Start server
const port = Number(PORT || 4000);
app.listen(port, () => console.log(`Server listening on ${port}`));

// ---------------- Scheduler (unchanged) ----------------

async function morningJob() {
  console.log("Morning job running at", new Date().toISOString());
  const { data: users } = await supabase.from("app_users").select("*");
  if (!users) return;
  for (const u of users) {
    await morningJobForUser(u).catch(e => console.error("morningJob user err", e));
  }
}

async function nightJob() {
  console.log("Night job running at", new Date().toISOString());
  const { data: users } = await supabase.from("app_users").select("*");
  if (!users) return;
  for (const u of users) {
    await nightJobForUser(u).catch(e => console.error("nightJob user err", e));
  }
}

// ---- New helper: morning job for single user
async function morningJobForUser(u) {
  const today = DateTime.now().setZone("Asia/Kolkata").toISODate();
  // fetch user's task ids
  const { data: userTasks } = await supabase.from("tasks").select("id").eq("user_id", u.id);
  const ids = (userTasks || []).map((t) => t.id);
  const { data: instances } = ids.length
    ? await supabase.from("task_instances").select("*, tasks(*)").eq("assigned_date", today).in("task_id", ids)
    : { data: [] };

  const { data: longRun } = await supabase.from("tasks").select("*").eq("user_id", u.id).eq("is_long_run", true);

  const instancesHtml = (instances || []).map(i => ({ title: i.tasks.title, description: i.tasks.description, completed: i.completed, assigned_date: i.assigned_date }));
  const longRunHtml = (longRun || []).map(l => ({ title: l.title, description: l.description }));

  const html = `
    <div style="font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial;">
      <p>Good morning ${escapeHtml(u.full_name || u.email)} — here are your tasks for <strong>${today}</strong>:</p>

      ${formatTaskList(instancesHtml)}
      <h3>Long-run tasks</h3>
      ${formatTaskList(longRunHtml)}
      <p style="font-size:12px;color:#777;margin-top:8px">This is a test email from your Planner app.</p>
    </div>
  `;

  try {
    await sendEmail(u.email, `Your tasks for ${today} — Test`, html);
    console.log("Morning test email sent to", u.email);
  } catch (e) {
    console.error("Failed to send morning email to", u.email, e);
    throw e;
  }
}

// ---- New helper: night job for single user
async function nightJobForUser(u) {
  const today = DateTime.now().setZone("Asia/Kolkata").toISODate();
  const tomorrow = DateTime.now().setZone("Asia/Kolkata").plus({ days: 1 }).toISODate();

  const { data: userTasks } = await supabase.from("tasks").select("id").eq("user_id", u.id);
  const ids = (userTasks || []).map(t => t.id);
  const { data: instances } = ids.length
    ? await supabase.from("task_instances").select("*, tasks(*)").eq("assigned_date", today).in("task_id", ids)
    : { data: [] };

  const completed = (instances || []).filter(i => i.completed);
  const incompleteShort = (instances || []).filter(i => !i.completed && !i.tasks.is_long_run);

  // append incomplete short-run tasks to tomorrow
  for (const inst of incompleteShort) {
    try {
      await supabase.from("task_instances").upsert(
        { task_id: inst.task_id, assigned_date: tomorrow },
        { onConflict: "task_id,assigned_date" }
      );
    } catch (e) {
      console.error("Failed to append instance:", e);
    }
  }

  const completedHtmlList = (completed || []).map(c => ({ title: c.tasks.title, description: c.tasks.description }));
  const movedHtmlList = (incompleteShort || []).map(c => ({ title: c.tasks.title, description: c.tasks.description }));

  const html = `
    <div style="font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial;">
      <p>Good night ${escapeHtml(u.full_name || u.email)} — summary for <strong>${today}</strong>:</p>
      <h3>Tasks you completed today</h3>
      ${formatTaskList(completedHtmlList)}
      <h3>Short-run tasks moved to ${tomorrow}</h3>
      ${formatTaskList(movedHtmlList)}
      <p style="font-size:12px;color:#777;margin-top:8px">This is a test email from your Planner app.</p>
    </div>
  `;

  try {
    await sendEmail(u.email, `Nightly summary for ${today} — Test`, html);
    console.log("Night test email sent to", u.email);
  } catch (e) {
    console.error("Failed to send night email to", u.email, e);
    throw e;
  }
}
// ----------------- Deletion endpoints -----------------

// Delete a master task (and its instances). Body should include user_id for simple auth check.
app.delete("/api/tasks/:taskId", async (req, res) => {
  try {
    const { taskId } = req.params;
    const { user_id } = req.body || {}; // optional but recommended

    // fetch task
    const { data: task, error: tErr } = await supabase
      .from("tasks")
      .select("*")
      .eq("id", taskId)
      .maybeSingle();
    if (tErr) return res.status(500).json({ error: tErr.message || tErr });
    if (!task) return res.status(404).json({ error: "task not found" });

    // simple ownership check if user_id provided
    if (user_id && task.user_id !== user_id) return res.status(403).json({ error: "forbidden" });

    // delete task instances explicitly (optional — cascade may already handle it)
    await supabase.from("task_instances").delete().eq("task_id", taskId);

    // delete the task itself
    const { error: delErr } = await supabase.from("tasks").delete().eq("id", taskId);
    if (delErr) return res.status(500).json({ error: delErr.message || delErr });

    // log into history (optional)
    await supabase.from("task_history").insert({
      task_instance_id: null,
      action: "task_deleted",
      info: { task_id: taskId, title: task.title, by_user: user_id || null }
    });

    res.json({ ok: true, deletedTaskId: taskId });
  } catch (e) {
    console.error("DELETE /tasks/:taskId error", e);
    res.status(500).json({ error: e.message });
  }
});

// Delete a task instance (the per-day assignment). Body should include user_id for simple auth check.
app.delete("/api/instances/:instanceId", async (req, res) => {
  try {
    const { instanceId } = req.params;
    const { user_id } = req.body || {};

    // fetch instance and its task to validate ownership
    const { data: inst, error: iErr } = await supabase
      .from("task_instances")
      .select("*, tasks(*)")
      .eq("id", instanceId)
      .maybeSingle();
    if (iErr) return res.status(500).json({ error: iErr.message || iErr });
    if (!inst) return res.status(404).json({ error: "instance not found" });

    // check owner if provided
    if (user_id && inst.tasks && inst.tasks.user_id !== user_id) return res.status(403).json({ error: "forbidden" });

    // delete instance
    const { error: delInstErr } = await supabase.from("task_instances").delete().eq("id", instanceId);
    if (delInstErr) return res.status(500).json({ error: delInstErr.message || delInstErr });

    // log deletion to history
    await supabase.from("task_history").insert({
      task_instance_id: instanceId,
      action: "instance_deleted",
      info: { task_id: inst.task_id, assigned_date: inst.assigned_date, by_user: user_id || null }
    });

    res.json({ ok: true, deletedInstanceId: instanceId });
  } catch (e) {
    console.error("DELETE /instances/:instanceId error", e);
    res.status(500).json({ error: e.message });
  }
});

// schedule: 08:00 IST morning, 21:00 IST night
cron.schedule("0 8 * * *", () => {
  morningJob().catch(e => console.error("morningJob error", e));
}, { timezone: "Asia/Kolkata" });

cron.schedule("0 21 * * *", () => {
  nightJob().catch(e => console.error("nightJob error", e));
}, { timezone: "Asia/Kolkata" });