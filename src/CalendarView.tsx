import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, CalendarDays } from "lucide-react";
import { calendarDays, calendarKey, calendarToday, dueDayKey, shiftCalendar, type CalendarMode } from "./calendar";

type CalendarTask = { id: string; title: string; dueAt: string | null; status: "open" | "done"; priority: number; projectId: string | null; tags: string[]; description: string };
type CalendarProject = { id: string; name: string; color: string };
type Props = { tasks: CalendarTask[]; projects: CalendarProject[]; timeZone: string; search: string; onEdit: (id: string) => void; onToggle: (id: string) => void };
const weekdays = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const civilFormat = (date: Date, options: Intl.DateTimeFormatOptions) => date.toLocaleDateString("zh-CN", { ...options, timeZone: "UTC" });

export default function CalendarView({ tasks, projects, timeZone, search, onEdit, onToggle }: Props) {
  let zone = timeZone || "Asia/Shanghai";
  try { new Intl.DateTimeFormat("zh-CN", { timeZone: zone }); } catch { zone = "Asia/Shanghai"; }
  const today = calendarToday(zone);
  const todayKey = calendarKey(today);
  const [mode, setMode] = useState<CalendarMode>("month");
  const [anchor, setAnchor] = useState(() => calendarToday(zone));
  const [selected, setSelected] = useState(() => calendarKey(calendarToday(zone)));
  const [projectId, setProjectId] = useState("all");
  const [showCompleted, setShowCompleted] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);
  const agendaRef = useRef<HTMLElement>(null);
  const days = calendarDays(anchor, mode);
  const projectMap = new Map(projects.map((project) => [project.id, project]));
  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return tasks.filter((task) => (showCompleted || task.status === "open") && (projectId === "all" || task.projectId === projectId)
      && (!query || `${task.title} ${task.description} ${task.tags.join(" ")}`.toLocaleLowerCase().includes(query)))
      .sort((a, b) => (a.status === "done" ? 1 : 0) - (b.status === "done" ? 1 : 0) || (a.dueAt ?? "").localeCompare(b.dueAt ?? "") || b.priority - a.priority);
  }, [tasks, projectId, showCompleted, search]);
  const byDay = useMemo(() => {
    const result = new Map<string, CalendarTask[]>();
    for (const task of filtered) {
      const key = task.dueAt ? dueDayKey(task.dueAt, zone) : null;
      if (key) result.set(key, [...(result.get(key) ?? []), task]);
    }
    return result;
  }, [filtered, zone]);
  const selectedTasks = byDay.get(selected) ?? [];
  const unscheduled = filtered.filter((task) => !task.dueAt);
  const periodDays = days.filter((day) => mode === "week" || day.getUTCMonth() === anchor.getUTCMonth());
  const pending = periodDays.reduce((sum, day) => sum + (byDay.get(calendarKey(day)) ?? []).filter((task) => task.status === "open").length, 0);
  const busyDays = periodDays.filter((day) => (byDay.get(calendarKey(day)) ?? []).filter((task) => task.status === "open").length >= 5).length;
  const heading = mode === "month" ? civilFormat(anchor, { year: "numeric", month: "long" }) : `${civilFormat(days[0], { year: "numeric", month: "short", day: "numeric" })} — ${civilFormat(days[6], { ...(days[0].getUTCFullYear() !== days[6].getUTCFullYear() ? { year: "numeric" } : {}), month: "short", day: "numeric" })}`;

  useEffect(() => {
    const scroller = gridRef.current;
    const cell = scroller?.querySelector<HTMLElement>(`[data-date="${selected}"]`);
    if (!scroller || !cell) return;
    const bounds = scroller.getBoundingClientRect();
    const position = cell.getBoundingClientRect();
    if (position.left < bounds.left || position.right > bounds.right) {
      scroller.scrollLeft += position.left - bounds.left - (scroller.clientWidth - position.width) / 2;
    }
  }, [selected, mode, anchor]);

  function move(direction: number) {
    const date = shiftCalendar(anchor, mode, direction);
    setAnchor(date); setSelected(calendarKey(date));
  }

  function taskButton(task: CalendarTask) {
    const project = projectMap.get(task.projectId ?? "");
    return <button key={task.id} className={`calendar-task ${task.status === "done" ? "done" : ""}`} style={{ borderLeftColor: project?.color ?? "#52796f" }} onClick={() => onEdit(task.id)} title={`${task.title} · ${project?.name ?? "未分类"}`}>
      {task.status === "done" && <Check size={11} />}
      <span>{task.title}</span>
      {task.priority >= 3 && <i aria-label="高优先级" />}
    </button>;
  }

  function agendaTask(task: CalendarTask) {
    const project = projectMap.get(task.projectId ?? "");
    const time = task.dueAt ? new Date(task.dueAt).toLocaleTimeString("zh-CN", { timeZone: zone, hour: "2-digit", minute: "2-digit", hour12: false }) : "未设截止时间";
    return <div className={`calendar-agenda-row ${task.status === "done" ? "is-done" : ""}`} key={task.id}>
      <button className={`task-check priority-${task.priority}`} aria-label={task.status === "done" ? `重新打开：${task.title}` : `完成：${task.title}`} onClick={() => onToggle(task.id)}>{task.status === "done" && <Check size={12} />}</button>
      <button className="task-body" onClick={() => onEdit(task.id)}><span className="task-title">{task.title}</span><span className="task-meta"><span>{time}</span><span><i className="project-dot" style={{ background: project?.color ?? "#52796f" }} />{project?.name ?? "未分类"}</span>{task.tags.length > 0 && <span>{task.tags.join(" · ")}</span>}</span></button>
    </div>;
  }

  return <section className="calendar-view" aria-label="截止日期日历">
    <div className="calendar-toolbar">
      <div className="calendar-navigation"><button className="icon-button" aria-label={mode === "month" ? "上个月" : "上一周"} onClick={() => move(-1)}><ChevronLeft size={19} /></button><h2 aria-live="polite">{heading}</h2><button className="icon-button" aria-label={mode === "month" ? "下个月" : "下一周"} onClick={() => move(1)}><ChevronRight size={19} /></button><button className="secondary-button" onClick={() => { setAnchor(today); setSelected(todayKey); }}>今天</button></div>
      <div className="calendar-mode" aria-label="日历显示方式">{(["month", "week"] as const).map((item) => <button key={item} className={mode === item ? "active" : ""} aria-pressed={mode === item} onClick={() => { setMode(item); setAnchor(new Date(`${selected}T12:00:00Z`)); }}>{item === "month" ? "月" : "周"}</button>)}</div>
    </div>
    <div className="calendar-filters"><label>项目<select aria-label="按项目筛选日历" value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="all">全部项目</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><label className="calendar-completed"><input type="checkbox" checked={showCompleted} onChange={(event) => setShowCompleted(event.target.checked)} />显示已完成</label><span>{zone}</span></div>
    <div className="calendar-summary"><span>本{mode === "month" ? "月" : "周"} <strong>{pending}</strong> 项待办</span>{busyDays > 0 && <span className="busy-summary">{busyDays} 天较满</span>}<small>每日 5 项及以上待办以暖色标记 · 点击日期查看全部任务</small></div>
    <div ref={gridRef} className="calendar-scroll" tabIndex={0} aria-label="日历日期，可横向滚动">
      <div className={`calendar-grid ${mode}`}>
        {weekdays.map((label) => <div className="calendar-weekday" key={label}>{label}</div>)}
        {days.map((day) => {
          const key = calendarKey(day);
          const items = byDay.get(key) ?? [];
          const count = items.filter((task) => task.status === "open").length;
          const outside = mode === "month" && day.getUTCMonth() !== anchor.getUTCMonth();
          return <div key={key} data-date={key} className={`calendar-cell ${outside ? "outside" : ""} ${selected === key ? "selected" : ""} ${count >= 5 ? "busy-day" : ""}`}>
            <button className="calendar-day" onClick={() => setSelected(key)} aria-pressed={selected === key} aria-label={`${civilFormat(day, { month: "long", day: "numeric" })}，${count} 项待办`}><span className={key === todayKey ? "today" : ""}>{day.getUTCDate()}{mode === "week" && <small>{day.getUTCMonth() + 1}月</small>}</span>{count > 0 && <em>{count}项</em>}</button>
            <div className="calendar-day-tasks">{items.slice(0, mode === "month" ? 3 : items.length).map(taskButton)}</div>
            {mode === "month" && items.length > 3 && <button className="calendar-more" onClick={() => { setSelected(key); agendaRef.current?.scrollIntoView({ block: "start" }); }}>还有 {items.length - 3} 项</button>}
          </div>;
        })}
      </div>
    </div>
    <section ref={agendaRef} className="calendar-agenda" aria-label="所选日期的任务"><div className="section-label"><span>{civilFormat(new Date(`${selected}T12:00:00Z`), { month: "long", day: "numeric", weekday: "long" })}</span><em>{selectedTasks.length}</em></div>{selectedTasks.length ? selectedTasks.map(agendaTask) : <div className="calendar-empty"><CalendarDays size={22} /><p>{search ? "这一天没有匹配的任务" : "这一天没有安排截止任务"}</p></div>}</section>
    {unscheduled.length > 0 && <details className="calendar-unscheduled"><summary>{unscheduled.length} 项任务尚未设置截止日期</summary><p className="field-hint">点击任务设置截止时间后，就会出现在日历中。</p>{unscheduled.map(agendaTask)}</details>}
  </section>;
}
