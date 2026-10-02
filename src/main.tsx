import React, { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Bell,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  Circle,
  Clock3,
  Folder,
  Inbox,
  ListTodo,
  LogOut,
  Menu,
  MoreHorizontal,
  Plus,
  Repeat2,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Tag,
  Trash2,
  X
} from "lucide-react";
import "./styles.css";

type Project = {
  id: string;
  name: string;
  description: string;
  color: string;
  position: number;
  createdAt: string;
  updatedAt: string;
};

type Task = {
  id: string;
  projectId: string | null;
  parentId: string | null;
  title: string;
  description: string;
  status: "open" | "done";
  priority: number;
  startAt: string | null;
  dueAt: string | null;
  reminderAt: string | null;
  reminderSentAt: string | null;
  recurrenceRule: "daily" | "weekly" | "monthly" | "yearly" | null;
  completedAt: string | null;
  position: number;
  tags: string[];
  createdAt: string;
  updatedAt: string;
};

type Notification = {
  id: string;
  task_id: string;
  title: string;
  body: string;
  read_at: string | null;
  created_at: string;
};

type SettingsMap = {
  timezone: string;
  email_enabled: string;
  email_to: string;
  email_from: string;
};

type Bootstrap = {
  projects: Project[];
  tasks: Task[];
  tags: { id: string; name: string; color: string }[];
  notifications: Notification[];
  settings: SettingsMap;
};

type View = "inbox" | "today" | "upcoming" | "completed" | `project:${string}`;

const priorityLabels = ["无", "低", "中", "高", "紧急"];
const recurrenceLabels: Record<string, string> = {
  daily: "每天",
  weekly: "每周",
  monthly: "每月",
  yearly: "每年"
};

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: options?.body ? { "Content-Type": "application/json", ...options.headers } : options?.headers
  });
  const body = (await response.json().catch(() => ({}))) as { error?: string } & T;
  if (!response.ok) throw new Error(body.error || "请求失败");
  return body;
}

function dateInputValue(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function toIso(value: string): string | null {
  return value ? new Date(value).toISOString() : null;
}

function dayKey(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function formatDue(value: string | null): { label: string; tone: "normal" | "today" | "overdue" } | null {
  if (!value) return null;
  const date = new Date(value);
  const now = new Date();
  const dateKey = dayKey(date);
  const today = dayKey(now);
  if (dateKey === today) {
    return { label: `今天 ${date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`, tone: "today" };
  }
  if (date < now) return { label: `已逾期 · ${date.toLocaleDateString("zh-CN", { month: "short", day: "numeric" })}`, tone: "overdue" };
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (dateKey === dayKey(tomorrow)) return { label: "明天", tone: "normal" };
  return { label: date.toLocaleDateString("zh-CN", { month: "short", day: "numeric", weekday: "short" }), tone: "normal" };
}

function Login({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/auth/login", { method: "POST", body: JSON.stringify({ password }) });
      onLogin();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "登录失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-page">
      <div className="login-ornament ornament-one" />
      <div className="login-ornament ornament-two" />
      <section className="login-card">
        <div className="brand-mark"><Check size={24} strokeWidth={2.8} /></div>
        <p className="eyebrow">WELCOME BACK</p>
        <h1>把今天，放回掌心。</h1>
        <p className="login-copy">Morrow 安静地记住每件事，让你把注意力留给真正重要的生活。</p>
        <form onSubmit={submit}>
          <label htmlFor="password">访问密码</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="输入你的私有密码"
            autoFocus
            autoComplete="current-password"
          />
          {error && <p className="form-error">{error}</p>}
          <button className="primary-button login-button" disabled={busy || !password}>
            {busy ? "正在进入…" : "进入 Morrow"}
          </button>
        </form>
        <p className="privacy-note">你的任务只保存在自己的 Cloudflare 账户中</p>
      </section>
    </main>
  );
}

function TaskEditor({
  task,
  projects,
  allTasks,
  defaultProjectId,
  onClose,
  onSaved,
  onDeleted
}: {
  task: Task | null;
  projects: Project[];
  allTasks: Task[];
  defaultProjectId: string;
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const [title, setTitle] = useState(task?.title ?? "");
  const [description, setDescription] = useState(task?.description ?? "");
  const [projectId, setProjectId] = useState(task?.projectId ?? defaultProjectId);
  const [parentId, setParentId] = useState(task?.parentId ?? "");
  const [priority, setPriority] = useState(task?.priority ?? 0);
  const [dueAt, setDueAt] = useState(dateInputValue(task?.dueAt ?? null));
  const [reminderAt, setReminderAt] = useState(dateInputValue(task?.reminderAt ?? null));
  const [recurrenceRule, setRecurrenceRule] = useState<Exclude<Task["recurrenceRule"], null> | "">(task?.recurrenceRule ?? "");
  const [tags, setTags] = useState(task?.tags.join(", ") ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setError("");
    const payload = {
      title,
      description,
      projectId,
      parentId: parentId || null,
      priority,
      dueAt: toIso(dueAt),
      reminderAt: toIso(reminderAt),
      recurrenceRule: recurrenceRule || null,
      tags: tags.split(/[,，]/).map((item) => item.trim()).filter(Boolean)
    };
    try {
      await api(task ? `/api/tasks/${task.id}` : "/api/tasks", {
        method: task ? "PUT" : "POST",
        body: JSON.stringify(payload)
      });
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!task || !window.confirm("删除这项任务？此操作无法撤销。")) return;
    setBusy(true);
    try {
      await api(`/api/tasks/${task.id}`, { method: "DELETE" });
      onDeleted();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "删除失败");
      setBusy(false);
    }
  }

  const possibleParents = allTasks.filter((item) => item.id !== task?.id && item.status === "open");

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="task-editor modal-panel" role="dialog" aria-modal="true">
        <header className="modal-header">
          <div>
            <p className="eyebrow">{task ? "EDIT TASK" : "NEW TASK"}</p>
            <h2>{task ? "整理这件事" : "记下一件事"}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭"><X size={20} /></button>
        </header>
        <form onSubmit={save} className="task-form">
          <label className="field field-title">
            <span>任务</span>
            <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="要完成什么？" autoFocus />
          </label>
          <label className="field">
            <span>补充说明</span>
            <textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="写下背景、链接或下一步…" rows={4} />
          </label>
          <div className="form-grid">
            <label className="field">
              <span>项目</span>
              <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
                {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
            </label>
            <label className="field">
              <span>优先级</span>
              <select value={priority} onChange={(event) => setPriority(Number(event.target.value))}>
                {priorityLabels.map((label, index) => <option value={index} key={label}>{label}</option>)}
              </select>
            </label>
            <label className="field">
              <span>截止时间</span>
              <input type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} />
            </label>
            <label className="field">
              <span>提醒时间</span>
              <input type="datetime-local" value={reminderAt} onChange={(event) => setReminderAt(event.target.value)} />
            </label>
            <label className="field">
              <span>重复</span>
              <select value={recurrenceRule} onChange={(event) => setRecurrenceRule(event.target.value as Exclude<Task["recurrenceRule"], null> | "")}>
                <option value="">不重复</option>
                <option value="daily">每天</option>
                <option value="weekly">每周</option>
                <option value="monthly">每月</option>
                <option value="yearly">每年</option>
              </select>
            </label>
            <label className="field">
              <span>父任务</span>
              <select value={parentId} onChange={(event) => setParentId(event.target.value)}>
                <option value="">无</option>
                {possibleParents.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
              </select>
            </label>
          </div>
          <label className="field">
            <span>标签 <small>用逗号分隔</small></span>
            <input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="工作, 等待中" />
          </label>
          {error && <p className="form-error">{error}</p>}
          <footer className="modal-actions">
            {task ? <button type="button" className="danger-button" onClick={remove} disabled={busy}><Trash2 size={17} />删除</button> : <span />}
            <div>
              <button type="button" className="text-button" onClick={onClose}>取消</button>
              <button className="primary-button" disabled={busy || !title.trim()}>{busy ? "保存中…" : "保存任务"}</button>
            </div>
          </footer>
        </form>
      </section>
    </div>
  );
}

function SettingsDialog({ settings, onClose, onSaved }: { settings: SettingsMap; onClose: () => void; onSaved: () => void }) {
  const [values, setValues] = useState(settings);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const set = (key: keyof SettingsMap, value: string) => setValues((current) => ({ ...current, [key]: value }));

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ ...values, email_enabled: values.email_enabled === "true" })
      });
      onSaved();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function testEmail() {
    setBusy(true);
    setMessage("");
    try {
      await api("/api/settings", { method: "PUT", body: JSON.stringify(values) });
      await api("/api/settings/test-email", { method: "POST" });
      setMessage("测试邮件已发送，请检查收件箱。");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "发送失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal-panel settings-panel" role="dialog" aria-modal="true">
        <header className="modal-header">
          <div><p className="eyebrow">PREFERENCES</p><h2>设置</h2></div>
          <button className="icon-button" onClick={onClose}><X size={20} /></button>
        </header>
        <form onSubmit={save} className="settings-form">
          <div className="settings-section">
            <h3>时间与地区</h3>
            <label className="field"><span>时区</span><input value={values.timezone} onChange={(event) => set("timezone", event.target.value)} /></label>
          </div>
          <div className="settings-section">
            <div className="setting-switch-row">
              <div><h3>邮件提醒</h3><p>到达任务提醒时间时发送邮件</p></div>
              <button type="button" className={`switch ${values.email_enabled === "true" ? "on" : ""}`} onClick={() => set("email_enabled", values.email_enabled === "true" ? "false" : "true")} aria-label="切换邮件提醒"><span /></button>
            </div>
            <label className="field"><span>收件地址</span><input type="email" value={values.email_to} onChange={(event) => set("email_to", event.target.value)} placeholder="you@example.com" /></label>
            <label className="field"><span>发件地址</span><input type="email" value={values.email_from} onChange={(event) => set("email_from", event.target.value)} placeholder="reminder@your-domain.com" /></label>
            <p className="field-hint">发件域名需先在 Resend 中完成验证，API 密钥保存在 Worker Secret 中。</p>
            <button type="button" className="secondary-button" onClick={testEmail} disabled={busy}>发送测试邮件</button>
          </div>
          {message && <p className={message.includes("已发送") ? "success-message" : "form-error"}>{message}</p>}
          <footer className="modal-actions"><span /><div><button type="button" className="text-button" onClick={onClose}>取消</button><button className="primary-button" disabled={busy}>{busy ? "保存中…" : "保存设置"}</button></div></footer>
        </form>
      </section>
    </div>
  );
}

function ProjectDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [color, setColor] = useState("#52796f");
  const [busy, setBusy] = useState(false);
  const colors = ["#52796f", "#c36f54", "#8f729b", "#bb8b35", "#5276a0", "#6d7b4d"];
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    await api("/api/projects", { method: "POST", body: JSON.stringify({ name, color }) });
    onSaved();
  }
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal-panel small-panel">
        <header className="modal-header"><div><p className="eyebrow">NEW PROJECT</p><h2>新建项目</h2></div><button className="icon-button" onClick={onClose}><X size={20} /></button></header>
        <form onSubmit={save} className="task-form">
          <label className="field"><span>项目名称</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：新家计划" autoFocus /></label>
          <div className="color-picker">{colors.map((item) => <button key={item} type="button" className={item === color ? "selected" : ""} style={{ backgroundColor: item }} onClick={() => setColor(item)} aria-label={item}>{item === color && <Check size={15} />}</button>)}</div>
          <footer className="modal-actions"><span /><div><button type="button" className="text-button" onClick={onClose}>取消</button><button className="primary-button" disabled={!name.trim() || busy}>创建项目</button></div></footer>
        </form>
      </section>
    </div>
  );
}

function TaskRow({ task, isSubtask, onToggle, onEdit }: { task: Task; isSubtask: boolean; onToggle: () => void; onEdit: () => void }) {
  const due = formatDue(task.dueAt);
  return (
    <article className={`task-row ${task.status === "done" ? "is-done" : ""} ${isSubtask ? "is-subtask" : ""}`}>
      <button className={`task-check priority-${task.priority}`} onClick={onToggle} aria-label={task.status === "done" ? "恢复任务" : "完成任务"}>
        {task.status === "done" ? <Check size={15} strokeWidth={3} /> : null}
      </button>
      <button className="task-body" onClick={onEdit}>
        <span className="task-title">{task.title}</span>
        <span className="task-meta">
          {due && <span className={`due-pill ${due.tone}`}><Clock3 size={13} />{due.label}</span>}
          {task.recurrenceRule && <span><Repeat2 size={13} />{recurrenceLabels[task.recurrenceRule]}</span>}
          {task.tags.map((tag) => <span className="tag-pill" key={tag}>#{tag}</span>)}
        </span>
      </button>
      <button className="row-more" onClick={onEdit} aria-label="编辑任务"><MoreHorizontal size={19} /></button>
    </article>
  );
}

function App() {
  const [authState, setAuthState] = useState<"loading" | "authenticated" | "guest">("loading");
  const [data, setData] = useState<Bootstrap | null>(null);
  const [view, setView] = useState<View>("today");
  const [search, setSearch] = useState("");
  const [quickTitle, setQuickTitle] = useState("");
  const [editorTask, setEditorTask] = useState<Task | null | undefined>(undefined);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [projectOpen, setProjectOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [toast, setToast] = useState("");
  const quickRef = useRef<HTMLInputElement>(null);

  async function checkAuth() {
    const status = await api<{ authenticated: boolean }>("/api/auth/status");
    setAuthState(status.authenticated ? "authenticated" : "guest");
  }

  async function refresh() {
    const next = await api<Bootstrap>("/api/bootstrap");
    setData(next);
  }

  useEffect(() => { checkAuth().catch(() => setAuthState("guest")); }, []);
  useEffect(() => { if (authState === "authenticated") refresh().catch((cause) => setToast(cause.message)); }, [authState]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const currentProjectId = view.startsWith("project:") ? view.slice(8) : "inbox";
  const currentProject = data?.projects.find((item) => item.id === currentProjectId);

  const visibleTasks = useMemo(() => {
    if (!data) return [];
    const now = new Date();
    const end = new Date(now);
    end.setDate(end.getDate() + 7);
    const query = search.trim().toLocaleLowerCase();
    return data.tasks.filter((task) => {
      if (query && !`${task.title} ${task.description} ${task.tags.join(" ")}`.toLocaleLowerCase().includes(query)) return false;
      if (view === "completed") return task.status === "done";
      if (task.status === "done") return false;
      if (view === "inbox") return task.projectId === "inbox";
      if (view === "today") return Boolean(task.dueAt && new Date(task.dueAt) <= new Date(`${dayKey(now)}T23:59:59`));
      if (view === "upcoming") return Boolean(task.dueAt && new Date(task.dueAt) > now && new Date(task.dueAt) <= end);
      if (view.startsWith("project:")) return task.projectId === view.slice(8);
      return true;
    });
  }, [data, view, search]);

  const viewInfo = useMemo(() => {
    if (view === "today") return { eyebrow: new Date().toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" }), title: "今天", subtitle: "只看此刻需要在意的事。" };
    if (view === "upcoming") return { eyebrow: "NEXT 7 DAYS", title: "即将到期", subtitle: "看看未来一周，给重要的事留出空间。" };
    if (view === "completed") return { eyebrow: "ARCHIVE", title: "已完成", subtitle: "这些事情已经妥善落地。" };
    if (view === "inbox") return { eyebrow: "CAPTURE", title: "收件箱", subtitle: "先记下来，稍后再整理。" };
    return { eyebrow: "PROJECT", title: currentProject?.name ?? "项目", subtitle: currentProject?.description || "把相互关联的事情放在一起。" };
  }, [view, currentProject]);

  async function quickAdd(event: FormEvent) {
    event.preventDefault();
    if (!quickTitle.trim()) return;
    try {
      await api("/api/tasks", { method: "POST", body: JSON.stringify({ title: quickTitle, projectId: currentProjectId }) });
      setQuickTitle("");
      await refresh();
      setToast("任务已记下");
    } catch (cause) {
      setToast(cause instanceof Error ? cause.message : "添加失败");
    }
  }

  async function toggleTask(task: Task) {
    try {
      await api(`/api/tasks/${task.id}`, { method: "PUT", body: JSON.stringify({ status: task.status === "done" ? "open" : "done" }) });
      await refresh();
      if (task.status === "open") setToast(task.recurrenceRule ? "已完成，并创建了下一次任务" : "做得好，已经完成");
    } catch (cause) {
      setToast(cause instanceof Error ? cause.message : "更新失败");
    }
  }

  async function markNotificationsRead() {
    await api("/api/notifications/read", { method: "POST" });
    await refresh();
  }

  async function logout() {
    await api("/api/auth/logout", { method: "POST" });
    setData(null);
    setAuthState("guest");
  }

  function changeView(next: View) {
    setView(next);
    setSidebarOpen(false);
  }

  if (authState === "loading") return <div className="app-loader"><div className="brand-mark"><Check size={24} /></div><span>正在准备今天…</span></div>;
  if (authState === "guest") return <Login onLogin={() => setAuthState("authenticated")} />;
  if (!data) return <div className="app-loader"><div className="brand-mark"><Check size={24} /></div><span>正在取回任务…</span></div>;

  const unread = data.notifications.filter((item) => !item.read_at).length;
  const openCount = (projectId: string) => data.tasks.filter((task) => task.projectId === projectId && task.status === "open").length;

  return (
    <div className="app-shell">
      <button className={`sidebar-scrim ${sidebarOpen ? "visible" : ""}`} onClick={() => setSidebarOpen(false)} aria-label="关闭菜单" />
      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="brand"><div className="brand-mark"><Check size={20} strokeWidth={3} /></div><span>Morrow</span></div>
        <nav className="primary-nav">
          <button className={view === "inbox" ? "active" : ""} onClick={() => changeView("inbox")}><Inbox size={18} /><span>收件箱</span><em>{openCount("inbox")}</em></button>
          <button className={view === "today" ? "active" : ""} onClick={() => changeView("today")}><Sparkles size={18} /><span>今天</span></button>
          <button className={view === "upcoming" ? "active" : ""} onClick={() => changeView("upcoming")}><CalendarDays size={18} /><span>即将到期</span></button>
          <button className={view === "completed" ? "active" : ""} onClick={() => changeView("completed")}><CheckCircle2 size={18} /><span>已完成</span></button>
        </nav>
        <div className="nav-heading"><span>项目</span><button onClick={() => setProjectOpen(true)} aria-label="新建项目"><Plus size={17} /></button></div>
        <nav className="project-nav">
          {data.projects.filter((project) => project.id !== "inbox").map((project) => (
            <button key={project.id} className={view === `project:${project.id}` ? "active" : ""} onClick={() => changeView(`project:${project.id}`)}>
              <span className="project-dot" style={{ backgroundColor: project.color }} /><span>{project.name}</span><em>{openCount(project.id)}</em>
            </button>
          ))}
        </nav>
        <footer className="sidebar-footer">
          <button onClick={() => setSettingsOpen(true)}><Settings size={18} /><span>设置</span></button>
          <button onClick={logout}><LogOut size={18} /><span>退出</span></button>
        </footer>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <button className="mobile-menu icon-button" onClick={() => setSidebarOpen(true)}><Menu size={20} /></button>
          <div className="search-box"><Search size={18} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索任务、标签…" /><kbd>⌘ K</kbd></div>
          <div className="top-actions">
            <div className="notification-wrap">
              <button className="icon-button notification-button" onClick={() => setNotificationsOpen((open) => !open)} aria-label="通知"><Bell size={20} />{unread > 0 && <i>{unread}</i>}</button>
              {notificationsOpen && (
                <div className="notifications-popover">
                  <header><div><p className="eyebrow">NOTIFICATIONS</p><h3>提醒</h3></div>{unread > 0 && <button onClick={markNotificationsRead}>全部已读</button>}</header>
                  <div className="notification-list">
                    {data.notifications.length === 0 ? <div className="empty-notifications"><Bell size={24} /><p>还没有新的提醒</p></div> : data.notifications.map((item) => (
                      <article key={item.id} className={!item.read_at ? "unread" : ""}><span /><div><strong>{item.body}</strong><p>{new Date(item.created_at).toLocaleString("zh-CN")}</p></div></article>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <button className="new-task-button" onClick={() => setEditorTask(null)}><Plus size={18} />新任务</button>
          </div>
        </header>

        <div className="content-wrap">
          <section className="view-header">
            <div><p className="eyebrow">{viewInfo.eyebrow}</p><h1>{viewInfo.title}</h1><p>{viewInfo.subtitle}</p></div>
            <button className="filter-button"><SlidersHorizontal size={17} />筛选<ChevronDown size={15} /></button>
          </section>

          {view !== "completed" && (
            <form className="quick-add" onSubmit={quickAdd}>
              <Circle size={20} />
              <input ref={quickRef} value={quickTitle} onChange={(event) => setQuickTitle(event.target.value)} placeholder="快速添加任务，然后按回车" />
              <button type="button" onClick={() => setEditorTask(null)}>详细设置</button>
            </form>
          )}

          <section className="task-section">
            <div className="section-label"><span>{view === "completed" ? "完成记录" : "任务"}</span><em>{visibleTasks.length}</em></div>
            <div className="task-list">
              {visibleTasks.length ? visibleTasks.map((task) => (
                <TaskRow key={task.id} task={task} isSubtask={Boolean(task.parentId)} onToggle={() => toggleTask(task)} onEdit={() => setEditorTask(task)} />
              )) : (
                <div className="empty-state">
                  <div className="empty-illustration"><ListTodo size={34} /><span><Check size={16} /></span></div>
                  <h3>{search ? "没有找到匹配的任务" : view === "completed" ? "完成一件事后，它会出现在这里" : "这里已经清空了"}</h3>
                  <p>{search ? "换一个关键词试试看。" : "享受这片空白，或者记下一件新事情。"}</p>
                  {!search && view !== "completed" && <button onClick={() => quickRef.current?.focus()}><Plus size={16} />添加第一项任务</button>}
                </div>
              )}
            </div>
          </section>
        </div>
      </main>

      {editorTask !== undefined && <TaskEditor task={editorTask} projects={data.projects} allTasks={data.tasks} defaultProjectId={currentProjectId} onClose={() => setEditorTask(undefined)} onSaved={async () => { setEditorTask(undefined); await refresh(); setToast("任务已保存"); }} onDeleted={async () => { setEditorTask(undefined); await refresh(); setToast("任务已删除"); }} />}
      {settingsOpen && <SettingsDialog settings={data.settings} onClose={() => setSettingsOpen(false)} onSaved={async () => { setSettingsOpen(false); await refresh(); setToast("设置已保存"); }} />}
      {projectOpen && <ProjectDialog onClose={() => setProjectOpen(false)} onSaved={async () => { setProjectOpen(false); await refresh(); setToast("项目已创建"); }} />}
      {toast && <div className="toast"><Check size={16} />{toast}</div>}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
