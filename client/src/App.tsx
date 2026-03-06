// todo-app/client/src/App.tsx
import React, { useEffect, useState } from "react";
import api from "./api";
import { Task, Instance } from "./types";
import "./styles.css";

export default function App() {
  const [user, setUser] = useState<{ id: string; email: string } | null>(null);
  const [date, setDate] = useState<string>(new Date().toISOString().slice(0, 10));
  const [instances, setInstances] = useState<Instance[]>([]);
  const [longRun, setLongRun] = useState<Task[]>([]);
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [isLong, setIsLong] = useState(false);
  const [loadingMail, setLoadingMail] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  // replaces the previous "ask for email" useEffect
useEffect(() => {
  // hard-coded demo user email
  const hardcodedEmail = "kshivam22@iitk.ac.in";

  // create / upsert the user on every app start and save to localStorage
  (async () => {
    try {
      const { data } = await api.post("/users", { email: hardcodedEmail, full_name: "K Shivam" });
      setUser({ id: data.id, email: data.email });
      localStorage.setItem("todo_user", JSON.stringify({ id: data.id, email: data.email }));
    } catch (err) {
      console.error("Failed to create/fetch hardcoded user:", err);
    }
  })();
}, []);

  useEffect(() => {
    if (!user) return;
    fetchTasks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, date]);

  async function fetchTasks() {
    if (!user) return;
    try {
      const res = await api.get(`/users/${user.id}/tasks`, { params: { date } });
      setInstances(res.data.instances || []);
      setLongRun(res.data.longRun || []);
    } catch (e) {
      console.error(e);
    }
  }

  async function createTask() {
    if (!user) return alert("Login first");
    const payload: any = {
      user_id: user.id,
      title,
      description: desc,
      is_long_run: isLong
    };
    if (!isLong) payload.assign_date = date;
    try {
      await api.post("/tasks", payload);
      setTitle("");
      setDesc("");
      setIsLong(false);
      fetchTasks();
    } catch (e) {
      console.error(e);
      alert("Failed to create task");
    }
  }

  async function toggleComplete(instanceId: string, completed: boolean) {
    try {
      await api.post(`/instances/${instanceId}/complete`, { completed });
      fetchTasks();
    } catch (e) {
      console.error(e);
    }
  }

  async function assignToDate(taskId: string) {
    try {
      await api.post(`/tasks/${taskId}/assign`, { assigned_date: date });
      fetchTasks();
    } catch (e) {
      console.error(e);
    }
  }

  async function editTask(task: Task) {
    const newTitle = prompt("Title", task.title) || task.title;
    const newDesc = prompt("Description", task.description || "") || task.description || "";
    try {
      await api.put(`/tasks/${task.id}`, { title: newTitle, description: newDesc });
      fetchTasks();
    } catch (e) {
      console.error(e);
    }
  }

  // ---- New: Send test email for current user
  async function sendTestEmail(mode: "morning" | "night" | "both") {
    if (!user) return alert("Login first");
    setLoadingMail(true);
    setFeedback(null);
    try {
      const res = await api.post("/send/test", { user_id: user.id, mode });
      setFeedback(`Test email sent (${mode}) to ${res.data.sentTo}`);
    } catch (err: any) {
      console.error(err);
      const msg = err?.response?.data?.error || err?.message || "Failed to send";
      setFeedback("Error: " + msg);
    } finally {
      setLoadingMail(false);
      setTimeout(() => setFeedback(null), 6000);
    }
  }

  // ---- New: Delete a task instance
  async function deleteInstance(instanceId: string) {
    if (!user) return alert("Login first");
    if (!confirm("Delete this task assignment for the day? This cannot be undone.")) return;
    try {
      await api.delete(`/instances/${instanceId}`, { data: { user_id: user.id } });
      setFeedback("Instance deleted");
      fetchTasks();
    } catch (err: any) {
      console.error(err);
      setFeedback("Error deleting instance: " + (err?.response?.data?.error || err.message));
    } finally {
      setTimeout(() => setFeedback(null), 4000);
    }
  }

  // ---- New: Delete a master task
  async function deleteTask(taskId: string) {
    if (!user) return alert("Login first");
    if (!confirm("Delete this task and all its daily assignments? This cannot be undone.")) return;
    try {
      await api.delete(`/tasks/${taskId}`, { data: { user_id: user.id } });
      setFeedback("Task deleted");
      fetchTasks();
    } catch (err: any) {
      console.error(err);
      setFeedback("Error deleting task: " + (err?.response?.data?.error || err.message));
    } finally {
      setTimeout(() => setFeedback(null), 4000);
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <h1>Planner</h1>
        <div className="top-actions">
          <div className="mail-controls">
            <button className="btn btn-outline" onClick={() => sendTestEmail("morning")} disabled={loadingMail}>
              Send test — morning
            </button>
            <button className="btn btn-outline" onClick={() => sendTestEmail("night")} disabled={loadingMail}>
              Send test — night
            </button>
            <button className="btn" onClick={() => sendTestEmail("both")} disabled={loadingMail}>
              Send both
            </button>
          </div>
          <div className="user-badge">{user ? <span>{user.email}</span> : <span>Not logged</span>}</div>
        </div>
      </header>

      <main className="container">
        <aside className="left-panel">
          <div className="card">
            <label className="date-label">
              <strong>Date</strong>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </label>

            <div style={{ marginTop: 12 }}>
              <h3>Add task</h3>
              <input value={title} placeholder="Title" onChange={(e) => setTitle(e.target.value)} className="input" />
              <textarea value={desc} placeholder="Description" onChange={(e) => setDesc(e.target.value)} className="textarea" />
              <label className="row">
                <input type="checkbox" checked={isLong} onChange={(e) => setIsLong(e.target.checked)} /> Long-run
              </label>
              <button className="btn btn-primary" onClick={createTask}>Create task</button>
            </div>

            {feedback && <div className="feedback">{feedback}</div>}
          </div>

          <div className="card">
            <h3>Long-run tasks</h3>
            {longRun.length === 0 && <div className="muted">No long-run tasks</div>}
            <ul className="task-list">
              {longRun.map((t) => (
                <li key={t.id} className="task-row">
                  <div>
                    <strong>{t.title}</strong>
                    <div className="muted small">{t.description}</div>
                  </div>
                  <div className="task-actions">
                    <button className="btn-sm" onClick={() => assignToDate(t.id)}>Assign</button>
                    <button className="btn-sm" onClick={() => editTask(t)}>Edit</button>
                    <button className="btn-sm" onClick={() => deleteTask(t.id)} style={{ color: "#ef4444" }}>Delete</button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </aside>

        <section className="main-panel">
          <h2>Tasks for {date}</h2>
          <div className="grid">
            {instances.length === 0 && <div className="card muted">No tasks for this day.</div>}
            {instances.map((inst) => (
              <div key={inst.id} className="card task-card">
                <div className="task-card-body">
                  <div>
                    <div className="task-title">{inst.tasks?.title}</div>
                    <div className="muted small">{inst.tasks?.description}</div>
                  </div>
                  <div className="task-card-actions">
                    <button className={inst.completed ? "btn btn-ghost" : "btn btn-outline"} onClick={() => toggleComplete(inst.id, !inst.completed)}>
                      {inst.completed ? "Undo" : "Done"}
                    </button>
                    <button className="btn-sm" onClick={() => deleteInstance(inst.id)} style={{ marginLeft: 8, color: "#ef4444" }}>
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      </main>

      <footer className="footer">
        <small>Planner • morning emails at 08:00 IST • night summary at 21:00 IST</small>
      </footer>
    </div>
  );
}