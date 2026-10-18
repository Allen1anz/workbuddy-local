"use strict";
const $ = (id) => document.getElementById(id),
  state = {
    sessions: [],
    session: null,
    config: {},
    busy: false,
    resource: "experts",
    editing: null,
  };
function node(tag, text, className) {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (className) n.className = className;
  return n;
}
function toast(message) {
  $("toast").textContent = message;
  $("toast").classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $("toast").classList.add("hidden"), 4000);
}
async function api(path, options = {}) {
  const response = await fetch("/api" + path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  if (!response.ok) {
    let message;
    try {
      message = (await response.json()).error;
    } catch {}
    throw new Error(message || "请求失败：" + response.status);
  }
  return response.status === 204 ? null : response.json();
}
const payload = (data) => ({ body: JSON.stringify(data) });
function array(value) {
  return Array.isArray(value)
    ? value
    : value?.items || value?.sessions || value?.messages || value?.runs || [];
}
function markdown(container, text) {
  container.replaceChildren();
  let code = false,
    lines = [];
  for (const line of String(text || "").split("\n")) {
    if (line.startsWith("```")) {
      if (code) {
        container.append(node("pre", lines.join("\n")));
        lines = [];
      }
      code = !code;
      continue;
    }
    if (code) {
      lines.push(line);
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)/);
    if (heading) {
      container.append(node("h" + (heading[1].length + 1), heading[2]));
      continue;
    }
    const p = node("p");
    const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g;
    let last = 0;
    for (const match of line.matchAll(pattern)) {
      p.append(document.createTextNode(line.slice(last, match.index)));
      const token = match[0];
      if (token.startsWith("`")) p.append(node("code", token.slice(1, -1)));
      else if (token.startsWith("**")) p.append(node("strong", token.slice(2, -2)));
      else {
        const parts = token.match(/^\[([^\]]+)\]\((.+)\)$/),
          a = node("a", parts[1]);
        a.href = parts[2];
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        p.append(a);
      }
      last = match.index + token.length;
    }
    p.append(document.createTextNode(line.slice(last)));
    container.append(p);
  }
  if (code) container.append(node("pre", lines.join("\n")));
}
function message(role, text) {
  const wrap = node("article", undefined, "message " + role);
  wrap.append(node("div", role === "user" ? "你" : "工作伙伴", "message-label"));
  const body = node("div", undefined, "message-body");
  markdown(body, text);
  wrap.append(body);
  $("messages").append(wrap);
  return body;
}
function scroll() {
  $("messages").scrollTop = $("messages").scrollHeight;
}
function welcome() {
  const box = node("div", undefined, "welcome");
  box.append(
    node("div", "✳", "welcome-icon"),
    node("h2", "把工作交给你的伙伴"),
    node(
      "p",
      "从一个想法开始，整理资料、分析代码、制作文档。选择工作目录，连接模型，我们一起把它做好。",
    ),
  );
  const suggestions = node("div", undefined, "suggestions");
  [
    ["梳理项目", "分析当前工作目录的项目结构，说明如何运行。"],
    ["整理一份计划", "帮我制定一份清晰、可执行的本周工作计划。"],
    ["分析资料", "列出工作目录里的资料，并帮助我梳理重点。"],
    ["一起写作", "协助我起草一份专业的项目进展报告。"],
  ].forEach(([title, text]) => {
    const b = node("button");
    b.append(node("strong", title), node("span", text));
    b.onclick = () => {
      $("prompt").value = text;
      $("prompt").focus();
    };
    suggestions.append(b);
  });
  box.append(suggestions);
  $("messages").replaceChildren(box);
}
async function refreshSessions() {
  state.sessions = array(await api("/sessions"));
  updateWorkspaceLabel();
  $("sessions").replaceChildren();
  for (const s of state.sessions) {
    const b = node("button", s.title || "新对话", s.id === state.session ? "selected" : "");
    b.onclick = () => openSession(s.id);
    $("sessions").append(b);
  }
}
async function openSession(id) {
  if (state.busy) return toast("请等待当前对话完成");
  state.session = id;
  showPage("chat");
  $("messages").replaceChildren();
  const items = array(await api("/sessions/" + id + "/messages"));
  items
    .filter((m) => ["user", "assistant"].includes(m.role))
    .forEach((m) => message(m.role, m.content || m.text));
  if (!items.length) welcome();
  try {
    const events = array(await api("/sessions/" + id + "/events"));
    events.forEach((event) => {
      if (event.type === "tool" || event.event === "tool") activity(event.data || event);
    });
  } catch {}
  await refreshSessions();
  const session = state.sessions.find((s) => s.id === id);
  $("mode").value = session?.mode || "craft";
  $("expert-select").value = session?.expertId || "";
  document.querySelectorAll("#skill-options input").forEach((input) => {
    input.checked = (session?.skillIds || []).includes(input.value);
  });
  scroll();
}
async function newSession() {
  if (state.busy) return;
  const s = await api("/sessions", { method: "POST", ...payload({ title: "新对话" }) });
  await openSession(s.id);
}
function configDisplay() {
  const c = state.config;
  $("base-url").value = c.baseURL || "";
  $("model").value = c.model || "";
  $("workspace").value = c.workspace || "";
  $("api-key").value = "";
  $("key-state").textContent = c.apiKeySet ? "密钥已保存，留空保留现有密钥" : "尚未保存密钥";
  $("supports-tools").checked = c.supportsTools !== false;
  updateWorkspaceLabel();
  $("model-label").textContent =
    state.sessions.find((session) => session.id === state.session)?.model ||
    c.model ||
    "配置模型后开始";
  $("connection").textContent = c.model ? "本地服务已连接" : "本地已连接 · 请配置模型";
}
function showSettings() {
  configDisplay();
  $("settings").classList.remove("hidden");
  refreshLocalModel().catch(error => { $("local-model-status").textContent = error.message; });
}
$("settings-open").onclick = showSettings;
$("settings-open-top").onclick = showSettings;
$("settings-close").onclick = () => $("settings").classList.add("hidden");
$("settings").onclick = (e) => {
  if (e.target === $("settings")) $("settings").classList.add("hidden");
};
$("settings-form").onsubmit = async (e) => {
  e.preventDefault();
  try {
    const data = {
      baseURL: $("base-url").value.trim(),
      model: $("model").value.trim(),
      workspace: $("workspace").value.trim(),
      supportsTools: $("supports-tools").checked,
    };
    if ($("api-key").value) data.apiKey = $("api-key").value;
    state.config = await api("/config", { method: "PUT", ...payload(data) });
    configDisplay();
    $("settings-feedback").textContent = "设置已保存";
    toast("模型与工作目录已保存");
  } catch (err) {
    $("settings-feedback").textContent = err.message;
  }
};
let localModelTimer, localModelState;
async function refreshLocalModel() {
  clearTimeout(localModelTimer);
  localModelState = await api("/local-model/status");
  const value = localModelState;
  $("local-model-status").textContent = value.available
    ? value.message + (value.status === "downloading" ? " · " + value.progress + "%" : "") + (value.error ? "：" + value.error : "")
    : "网页开发模式未打包本地运行器；请下载 Mac 安装版，或填写下方模型接口。";
  $("local-model-download").disabled = !value.available || ["starting", "downloading"].includes(value.status);
  $("local-model-use").disabled = value.status !== "ready";
  $("local-model-stop").disabled = !value.available || value.status === "stopped";
  $("local-model-progress").classList.toggle("hidden", value.status !== "downloading");
  $("local-model-progress").value = value.progress;
  if (!$("settings").classList.contains("hidden") || ["starting", "downloading"].includes(value.status))
    localModelTimer = setTimeout(() => refreshLocalModel().catch(error => { $("local-model-status").textContent = error.message; }), 1000);
}
$("local-model-download").onclick = async () => {
  $("local-model-download").disabled = true;
  $("local-model-status").textContent = "正在准备本地模型…";
  try { await api("/local-model/download", { method: "POST" }); await refreshLocalModel(); }
  catch (error) { $("local-model-status").textContent = error.message; $("local-model-download").disabled = false; }
};
$("local-model-use").onclick = async () => {
  try {
    const status = await api("/local-model/status");
    if (status.status !== "ready") throw Error("请等待模型下载完成");
    state.config = await api("/config", { method: "PUT", ...payload({ baseURL: status.baseURL, model: status.model, apiKey: "", supportsTools: true }) });
    configDisplay(); $("settings-feedback").textContent = "本地模型已选中，可以开始对话。";
    toast("已使用本地模型");
  } catch (error) { $("settings-feedback").textContent = error.message; }
};
$("local-model-stop").onclick = async () => {
  try { await api("/local-model/stop", { method: "POST" }); await refreshLocalModel(); }
  catch (error) { $("local-model-status").textContent = error.message; }
};
if (window.publicDesktop) {
  $("workspace-choose").classList.remove("hidden");
  $("workspace-choose").onclick = async () => {
    try { const selected = await window.publicDesktop.selectWorkspace(); if (selected) $("workspace").value = selected; }
    catch (error) { $("settings-feedback").textContent = error.message; }
  };
}
$("new-chat").onclick = () => newSession().catch((e) => toast(e.message));
$("prompt").onkeydown = (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("chat-form").requestSubmit();
  }
};
function activity(data, approval = false) {
  if (
    approval &&
    [...$("pending-approvals").children].some((card) => card.dataset.approvalId === data.id)
  )
    return;
  const box = node("div", undefined, "activity" + (approval ? " approval" : ""));
  if (approval) box.dataset.approvalId = data.id;
  box.append(
    node("strong", approval ? "需要你的确认 · " + data.name : "正在使用工具 · " + data.name),
  );
  box.append(node("pre", JSON.stringify(data.args || {}, null, 2)));
  if (approval) {
    const sessionId = data.sessionId || state.session;
    const session = state.sessions.find((item) => item.id === sessionId);
    if (sessionId) {
      box.append(node("p", "所属任务：" + (session?.title || sessionId)));
      const view = node("button", "打开所属对话");
      view.onclick = () => openSession(sessionId).catch((error) => toast(error.message));
      box.append(view);
    }
    if (data.name === "shell_execute")
      box.append(
        node("p", "命令以当前用户权限执行；工作目录不是系统沙箱。请检查命令及其影响后批准。"),
      );
    for (const [text, decision] of [
      ["允许执行", "approve"],
      ["拒绝", "deny"],
    ]) {
      const b = node("button", text, decision === "approve" ? "primary" : "");
      b.onclick = async () => {
        try {
          await api("/approvals/" + data.id, { method: "POST", ...payload({ decision }) });
          box.remove();
          toast(decision === "approve" ? "已允许执行" : "已拒绝执行");
        } catch (err) {
          toast(err.message);
        }
      };
      box.append(b);
    }
  }
  $(approval ? "pending-approvals" : "messages").append(box);
  scroll();
}
$("chat-form").onsubmit = async (e) => {
  e.preventDefault();
  if (state.busy) return;
  const text = $("prompt").value.trim();
  if (!text) return;
  if (!state.config.model) {
    showSettings();
    return toast("请先保存模型设置");
  }
  try {
    if (!state.session) await newSession();
    if ($("messages").querySelector(".welcome")) $("messages").replaceChildren();
    message("user", text);
    $("prompt").value = "";
    state.busy = true;
    $("send").disabled = true;
    $("cancel-chat").classList.remove("hidden");
    let reply = "",
      body = null;
    const response = await fetch("/api/sessions/" + state.session + "/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: text,
        expertId: $("expert-select").value || null,
        skillIds: [...document.querySelectorAll("#skill-options input:checked")].map(
          (x) => x.value,
        ),
        mode: $("mode").value,
      }),
    });
    if (!response.ok) throw new Error((await response.json()).error || "对话请求失败");
    const reader = response.body.getReader(),
      decoder = new TextDecoder();
    let buffer = "";
    function process(packet) {
      let type = "message",
        data = "";
      packet.split("\n").forEach((l) => {
        if (l.startsWith("event:")) type = l.slice(6).trim();
        if (l.startsWith("data:")) data += l.slice(5).trim();
      });
      if (!data) return;
      const value = JSON.parse(data);
      if (type === "delta") {
        if (!body) body = message("assistant", "");
        reply += value.text || "";
        markdown(body, reply);
        scroll();
      } else if (type === "tool") activity(value);
      else if (type === "approval") {
        activity(value, true);
      } else if (type === "tool_result") {
        const result = node("details", undefined, "activity");
        result.append(
          node("summary", "工具结果 · " + value.name),
          node(
            "pre",
            typeof value.result === "string" ? value.result : JSON.stringify(value.result, null, 2),
          ),
        );
        if (value.result?.url?.startsWith("/")) {
          const download = node("a", "下载生成文件 ↗");
          download.href = value.result.url;
          download.download = "";
          result.append(download);
        }
        $("messages").append(result);
        scroll();
      } else if (type === "error") throw new Error(value.message || "模型响应错误");
      else if (type === "done" && !reply && value.message) {
        body = message(
          "assistant",
          typeof value.message === "string" ? value.message : value.message.content || "",
        );
        scroll();
      }
    }
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done }).replace(/\r\n/g, "\n");
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        process(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
      }
      if (done) {
        if (buffer.trim()) process(buffer);
        break;
      }
    }
    await refreshSessions();
  } catch (err) {
    toast(err.message);
    $("messages").append(node("div", err.message, "activity"));
  } finally {
    state.busy = false;
    $("send").disabled = false;
    $("cancel-chat").classList.add("hidden");
    scroll();
  }
};
const info = {
  experts: ["专家", "为不同工作设定专门的角色与工作方法。"],
  skills: ["技能", "保存可复用的步骤、模板和工具说明。"],
  memories: ["长期记忆", "保存偏好和项目背景，在后续对话中继续使用。"],
  automations: ["自动化", "保存可反复执行的任务，并查看运行记录。"],
};
function showPage(page) {
  document
    .querySelectorAll("nav button")
    .forEach((b) => b.classList.toggle("active", b.dataset.page === page));
  $("chat-page").classList.toggle("hidden", page !== "chat");
  $("office-page").classList.toggle("hidden", page !== "office");
  $("connectors-page").classList.toggle("hidden", page !== "connectors");
  $("files-page").classList.toggle("hidden", page !== "files");
  $("resource-page").classList.toggle(
    "hidden",
    ["chat", "office", "connectors", "files"].includes(page),
  );
  $("page-title").textContent =
    page === "chat"
      ? "对话工作台"
      : page === "office"
        ? "文档产物"
        : page === "files"
          ? "工作目录"
          : page === "connectors"
            ? "连接器"
            : page === "experts"
              ? "专家与技能"
              : info[page][0];
  if (page === "files") loadFiles(".").catch((error) => toast(error.message));
  if (page === "connectors") loadConnectors().catch((e) => toast(e.message));
  if (page === "office") loadArtifacts().catch((e) => toast(e.message));
  if (!["chat", "office", "connectors", "files"].includes(page)) {
    state.resource = page;
    state.editing = null;
    loadResources().catch((e) => toast(e.message));
  }
}
document
  .querySelectorAll("nav button")
  .forEach((b) => (b.onclick = () => showPage(b.dataset.page)));
async function loadExperts() {
  const experts = array(await api("/experts"));
  $("expert-select").replaceChildren(node("option", "通用助手"));
  $("expert-select").firstChild.value = "";
  experts.forEach((item) => {
    const o = node("option", item.name);
    o.value = item.id;
    $("expert-select").append(o);
  });
}
async function loadResources() {
  const type = state.resource;
  $("resource-title").textContent = info[type][0];
  $("resource-description").textContent = info[type][1];
  $("resource-tabs").replaceChildren();
  if (["experts", "skills"].includes(type)) {
    const tabs = node("div", undefined, "tabs");
    ["experts", "skills"].forEach((t) => {
      const b = node("button", info[t][0], type === t ? "active" : "");
      b.onclick = () => {
        state.resource = t;
        state.editing = null;
        loadResources().catch((e) => toast(e.message));
      };
      tabs.append(b);
    });
    $("resource-tabs").append(tabs);
  }
  $("automation-fields").classList.toggle("hidden", type !== "automations");
  $("form-title").textContent = "添加" + info[type][0];
  $("resource-form").reset();
  $("cancel-edit").classList.add("hidden");
  const items = array(await api("/" + type));
  $("resource-list").replaceChildren();
  if (!items.length)
    $("resource-list").append(node("div", "还没有内容，添加第一条开始使用。", "empty"));
  items.forEach((item) => {
    const card = node("article", undefined, "card resource-item");
    card.append(
      node("h3", item.name || "未命名"),
      node("p", item.content || item.systemPrompt || item.prompt || ""),
    );
    const actions = node("div", undefined, "item-actions");
    const edit = node("button", "编辑");
    edit.onclick = () => {
      state.editing = item.id;
      $("resource-name").value = item.name || "";
      $("resource-content").value = item.content || item.systemPrompt || item.prompt || "";
      $("resource-schedule").value = item.schedule || "manual";
      $("resource-enabled").checked = !!item.enabled;
      $("resource-interval").value = item.intervalMinutes || "";
      $("form-title").textContent = "编辑" + info[type][0];
      $("cancel-edit").classList.remove("hidden");
    };
    const del = node("button", "删除");
    del.onclick = async () => {
      if (!(await confirmAction("确定删除“" + (item.name || "这条内容") + "”？"))) return;
      try {
        await api("/" + type + "/" + item.id, { method: "DELETE" });
        await loadResources();
        if (type === "experts") await loadExperts();
        if (type === "skills") await loadSkills();
      } catch (e) {
        toast(e.message);
      }
    };
    actions.append(edit, del);
    if (type === "automations") {
      const run = node("button", "立即运行");
      run.onclick = async () => {
        try {
          run.disabled = true;
          await api("/automations/" + item.id + "/run", { method: "POST" });
          toast("任务已启动");
          await loadRuns();
        } catch (e) {
          toast(e.message);
        } finally {
          run.disabled = false;
        }
      };
      actions.append(run);
      card.append(node("small", item.enabled ? "定时运行已启用 · " + item.schedule : "手动运行"));
    }
    card.append(actions);
    $("resource-list").append(card);
  });
  $("run-history").replaceChildren();
  if (type === "automations") await loadRuns();
}
async function loadRuns() {
  const runs = array(await api("/runs"));
  $("run-history").replaceChildren(node("h3", "运行记录"));
  runs
    .slice()
    .slice(0, 15)
    .forEach((run) => {
      const c = node("div", undefined, "card");
      c.append(
        node("strong", (run.name || run.automationId || "任务") + " · " + (run.status || "运行中")),
        node("p", run.output || run.result || run.error || ""),
        node("small", run.createdAt || run.startedAt || ""),
      );
      if (run.sessionId) {
        const button = node("button", "打开运行对话");
        button.onclick = () => openSession(run.sessionId).catch((error) => toast(error.message));
        c.append(button);
      }
      $("run-history").append(c);
    });
}
$("cancel-edit").onclick = () => {
  state.editing = null;
  loadResources().catch((e) => toast(e.message));
};
$("resource-form").onsubmit = async (e) => {
  e.preventDefault();
  const type = state.resource,
    data = { name: $("resource-name").value.trim() };
  data[type === "automations" ? "prompt" : type === "experts" ? "systemPrompt" : "content"] =
    $("resource-content").value;
  if (type === "automations") {
    data.schedule = $("resource-schedule").value;
    data.enabled = $("resource-enabled").checked;
    data.intervalMinutes = $("resource-interval").value
      ? Number($("resource-interval").value)
      : null;
  }
  try {
    await api("/" + type + (state.editing ? "/" + state.editing : ""), {
      method: state.editing ? "PUT" : "POST",
      ...payload(data),
    });
    state.editing = null;
    await loadResources();
    if (type === "experts") await loadExperts();
    if (type === "skills") await loadSkills();
    toast("已保存");
  } catch (err) {
    toast(err.message);
  }
};
$("office-form").onsubmit = async (e) => {
  e.preventDefault();
  const format = $("office-format").value,
    text = $("office-content").value,
    data = { format, title: $("office-title").value.trim() };
  if (format === "docx") data.paragraphs = text.split("\n");
  else if (format === "xlsx")
    data.rows = text.split("\n").map((row) => row.split(",").map((cell) => cell.trim()));
  else
    data.slides = text.split(/\n\s*\n/).map((block) => {
      const [title, ...body] = block.split("\n");
      return { title, body };
    });
  try {
    const result = await api("/office/export", { method: "POST", ...payload(data) });
    const url = result.url || result.downloadUrl;
    if (!url || !url.startsWith("/")) throw new Error("服务未返回有效下载地址");
    const a = node("a", "下载 " + (result.filename || data.title + "." + format));
    a.href = url;
    a.download = "";
    $("office-result").replaceChildren(a);
    toast("文件已生成");
    await loadArtifacts();
  } catch (err) {
    toast(err.message);
  }
};
async function init() {
  welcome();
  try {
    state.config = await api("/config");
    configDisplay();
    await refreshSessions();
    await loadExperts();
    await loadSkills();
    if (!state.config.model) showSettings();
  } catch (err) {
    $("connection").textContent = "本地服务连接失败";
    toast(err.message);
  }
}
init();

$("cancel-chat").onclick = () =>
  api("/sessions/" + state.session + "/cancel", { method: "POST" }).catch((e) => toast(e.message));
async function loadSkills() {
  const selected = [...document.querySelectorAll("#skill-options input:checked")].map(
    (input) => input.value,
  );
  const saved = state.sessions.find((session) => session.id === state.session)?.skillIds || [];
  const skillIds = $("skill-options").querySelector("input") ? selected : saved;
  const skills = array(await api("/skills"));
  $("skill-options").replaceChildren();
  skills.forEach((skill) => {
    const label = node("label", undefined, "check"),
      input = node("input");
    input.type = "checkbox";
    input.value = skill.id;
    input.checked = skillIds.includes(skill.id);
    label.append(input, document.createTextNode(" " + skill.name));
    $("skill-options").append(label);
  });
  if (!skills.length) $("skill-options").append(node("small", "在专家与技能中添加技能"));
}
setInterval(async () => {
  try {
    const pending = array(await api("/approvals"));
    const pendingIds = pending.map((item) => item.id);
    [...$("pending-approvals").children].forEach((card) => {
      if (!pendingIds.includes(card.dataset.approvalId)) card.remove();
    });
    pending.forEach((item) => activity(item, true));
    if (state.resource === "automations" && !$("resource-page").classList.contains("hidden"))
      await loadRuns();
  } catch {}
}, 5000);

async function loadArtifacts() {
  const items = array(await api("/office/artifacts"));
  $("office-artifacts").replaceChildren(node("h3", "最近生成"));
  items
    .slice()
    .slice(0, 20)
    .forEach((item) => {
      const card = node("div", undefined, "card");
      card.append(
        node("strong", item.title + " · " + item.format.toUpperCase()),
        node(
          "p",
          Math.ceil(item.bytes / 1024) + " KB · " + new Date(item.createdAt).toLocaleString(),
        ),
      );
      if (item.url?.startsWith("/")) {
        const a = node("a", "下载文件 ↗");
        a.href = item.url;
        a.download = "";
        card.append(a);
      }
      $("office-artifacts").append(card);
    });
}

let connectorEditing = null;
function connectorTransport() {
  const local = $("connector-transport").value === "stdio";
  $("connector-stdio").classList.toggle("hidden", !local);
  $("connector-http").classList.toggle("hidden", local);
  $("connector-command").required = local;
  $("connector-url").required = !local;
}
$("connector-transport").onchange = connectorTransport;
function resetConnector() {
  $("connector-form").reset();
  connectorEditing = null;
  $("connector-key-state").textContent = "";
  $("connector-env-state").textContent = "";
  $("connector-cancel").classList.add("hidden");
  connectorTransport();
}
$("connector-cancel").onclick = resetConnector;
async function loadConnectors() {
  const items = array(await api("/connectors"));
  $("connector-list").replaceChildren();
  if (!items.length)
    $("connector-list").append(
      node("div", "暂无连接器。保存配置后可以测试连接、查看工具。", "empty"),
    );
  items.forEach((item) => {
    const card = node("div", undefined, "card");
    card.append(
      node("h3", item.name),
      node("p", item.transport === "stdio" ? "本地程序：" + item.command : "HTTP：" + item.url),
    );
    const actions = node("div", undefined, "item-actions"),
      edit = node("button", "编辑"),
      connect = node("button", item.transport === "stdio" ? "启动程序并测试" : "测试连接"),
      remove = node("button", "删除");
    edit.onclick = () => {
      connectorEditing = item.id;
      $("connector-name").value = item.name || "";
      $("connector-transport").value = item.transport || "http";
      $("connector-url").value = item.url || "";
      $("connector-key").value = "";
      $("connector-key-state").textContent = item.apiKeySet ? "密钥已保存，留空保留" : "";
      $("connector-command").value = item.command || "";
      $("connector-args").value = (item.args || []).join("\n");
      $("connector-env").value = "";
      $("connector-env-state").textContent = item.envKeys?.length
        ? "已保存变量：" + item.envKeys.join("、") + "。留空保留。"
        : "";
      $("connector-cancel").classList.remove("hidden");
      connectorTransport();
    };
    connect.onclick = async () => {
      connect.disabled = true;
      try {
        const result = await api("/connectors/" + item.id + "/connect", { method: "POST" });
        const tools = node("div");
        tools.append(node("h3", "已连接 · " + (result.tools || []).length + " 个工具"));
        (result.tools || []).forEach((tool) => {
          tools.append(node("strong", tool.name), node("p", tool.description || ""));
        });
        card.querySelector(".connector-tools")?.remove();
        tools.className = "connector-tools";
        card.append(tools);
        toast("连接成功");
      } catch (error) {
        toast(error.message);
        card.append(node("p", "连接失败：" + error.message));
      } finally {
        connect.disabled = false;
      }
    };
    remove.onclick = async () => {
      if (!(await confirmAction("确定删除连接器“" + item.name + "”？"))) return;
      try {
        await api("/connectors/" + item.id, { method: "DELETE" });
        await loadConnectors();
      } catch (error) {
        toast(error.message);
      }
    };
    actions.append(connect, edit, remove);
    card.append(actions);
    $("connector-list").append(card);
  });
}
$("connector-form").onsubmit = async (e) => {
  e.preventDefault();
  try {
    const transport = $("connector-transport").value,
      data = { name: $("connector-name").value.trim(), transport };
    if (transport === "http") {
      data.url = $("connector-url").value.trim();
      if ($("connector-key").value) data.apiKey = $("connector-key").value;
    } else {
      data.command = $("connector-command").value.trim();
      data.args = $("connector-args").value.split("\n").filter(Boolean);
      if ($("connector-env").value.trim()) {
        const env = JSON.parse($("connector-env").value);
        if (
          !env ||
          Array.isArray(env) ||
          typeof env !== "object" ||
          Object.values(env).some((x) => typeof x !== "string")
        )
          throw new Error("环境变量必须是值为字符串的 JSON 对象");
        data.env = env;
      }
    }
    await api("/connectors" + (connectorEditing ? "/" + connectorEditing : ""), {
      method: connectorEditing ? "PUT" : "POST",
      ...payload(data),
    });
    resetConnector();
    await loadConnectors();
    toast("配置已保存，可以测试连接");
  } catch (error) {
    toast(error.message);
  }
};
connectorTransport();

$("model-test").onclick = async () => {
  const button = $("model-test");
  if (!state.config.model) return toast("请先保存模型与接口设置");
  button.disabled = true;
  $("settings-feedback").textContent = "正在测试模型连接…";
  try {
    const result = await api("/model/test", { method: "POST", ...payload({}) });
    if (!result.ok) throw new Error("模型连接未通过");
    $("settings-feedback").textContent = "连接成功 · " + result.model;
    toast("模型连接测试成功");
  } catch (error) {
    $("settings-feedback").textContent = "连接失败：" + error.message;
  } finally {
    button.disabled = false;
  }
};

function updateWorkspaceLabel() {
  const session = state.sessions.find((s) => s.id === state.session);
  const workspace = session?.workspace || state.config.workspace || "未选择工作目录";
  $("workspace-label").textContent = workspace;
  $("workspace-label").title = workspace;
  $("model-label").textContent = session?.model || state.config.model || "配置模型后开始";
}

const fileState = {
  path: ".",
  selected: null,
  hash: null,
  original: "",
  truncated: false,
  workspace: "",
  directoryWorkspace: "",
};
async function loadFiles(path) {
  const result = await api("/files?path=" + encodeURIComponent(path));
  fileState.path = result.path || path;
  fileState.directoryWorkspace = result.workspace;
  $("files-path").textContent = result.workspace + " / " + fileState.path;
  $("files-list").replaceChildren();
  $("files-parent").disabled = fileState.path === "." || fileState.path === "";
  for (const entry of result.entries || []) {
    const button = node(
      "button",
      (entry.type === "directory" ? "▸ " : "▤ ") + entry.name,
      "file-entry",
    );
    button.onclick = () =>
      (entry.type === "directory" ? loadFiles(entry.path) : openFile(entry.path)).catch((error) =>
        toast(error.message),
      );
    $("files-list").append(button);
  }
  if (!result.entries?.length) $("files-list").append(node("p", "目录为空", "muted"));
}
async function openFile(path) {
  fileState.selected = path;
  fileState.hash = null;
  $("file-title").textContent = path;
  $("file-office").replaceChildren();
  $("file-editor").classList.add("hidden");
  $("file-save").classList.add("hidden");
  const extension = path.split(".").pop().toLowerCase();
  if (["docx", "xlsx", "pptx"].includes(extension)) {
    $("file-info").textContent = "Office 内容预览 · 可在文档产物中生成新文件";
    const office = await api("/files/office?path=" + encodeURIComponent(path));
    if (office.paragraphs)
      office.paragraphs.forEach((paragraph) =>
        $("file-office").append(
          node(
            "p",
            typeof paragraph === "string" ? paragraph : paragraph.text || JSON.stringify(paragraph),
          ),
        ),
      );
    if (office.sheets)
      office.sheets.forEach((sheet) => {
        const section = node("div");
        section.append(node("h3", sheet.name || sheet.part || "工作表"));
        const table = node("table");
        const heading = node("tr");
        ["单元格", "值", "公式"].forEach((text) => heading.append(node("th", text)));
        table.append(heading);
        (sheet.cells || []).forEach((cell) => {
          const tr = node("tr");
          [cell.cell, cell.value, cell.formula || ""].forEach((value) =>
            tr.append(node("td", String(value ?? ""))),
          );
          table.append(tr);
        });
        if (sheet.truncated) section.append(node("p", "内容较多，已截断预览", "muted"));
        section.append(table);
        $("file-office").append(section);
      });
    if (office.slides)
      office.slides.forEach((slide, index) => {
        const section = node("article", undefined, "card");
        section.append(node("h3", slide.title || "第 " + (index + 1) + " 页"));
        (slide.paragraphs || []).forEach((text) => section.append(node("p", text)));
        $("file-office").append(section);
      });
    if (!office.paragraphs && !office.sheets && !office.slides)
      $("file-office").append(node("pre", JSON.stringify(office, null, 2)));
    return;
  }
  try {
    const result = await api("/files/content?path=" + encodeURIComponent(path));
    fileState.workspace = result.workspace;
    fileState.hash = result.sha256;
    fileState.original = result.text;
    fileState.truncated = !!result.truncated;
    $("file-editor").value = result.text;
    $("file-editor").readOnly = fileState.truncated;
    $("file-editor").classList.remove("hidden");
    $("file-save").classList.toggle("hidden", fileState.truncated);
    $("file-info").textContent =
      (result.bytes || 0) +
      " 字节" +
      (result.truncated ? " · 文件过大，仅预览，不可保存" : " · 保存前会检查文件版本");
  } catch (error) {
    $("file-info").textContent = "无法编辑此文件：" + error.message;
  }
}
$("files-parent").onclick = () => {
  const parts = fileState.path.split("/").filter((part) => part && part !== ".");
  parts.pop();
  loadFiles(parts.join("/") || ".").catch((error) => toast(error.message));
};
$("files-refresh").onclick = () => loadFiles(fileState.path).catch((error) => toast(error.message));
$("files-new").onclick = async () => {
  const name = await promptAction("输入新文本文件名（相对于当前目录）");
  if (!name) return;
  fileState.selected = (fileState.path === "." ? "" : fileState.path + "/") + name;
  fileState.hash = null;
  fileState.workspace = fileState.directoryWorkspace;
  fileState.original = "";
  fileState.truncated = false;
  $("file-title").textContent = fileState.selected;
  $("file-info").textContent = "新文件 · 保存时只创建，不覆盖已有文件";
  $("file-office").replaceChildren();
  $("file-editor").value = "";
  $("file-editor").readOnly = false;
  $("file-editor").classList.remove("hidden");
  $("file-save").classList.remove("hidden");
};
$("file-save").onclick = async () => {
  if (!fileState.selected || fileState.truncated) return;
  if (!(await confirmAction("确认保存文件“" + fileState.selected + "”？"))) return;
  try {
    const result = await api("/files/content", {
      method: "PUT",
      ...payload({
        path: fileState.selected,
        content: $("file-editor").value,
        expectedSha256: fileState.hash,
        expectedWorkspace: fileState.workspace,
      }),
    });
    fileState.hash = result.sha256;
    fileState.original = $("file-editor").value;
    toast("文件已保存");
    await loadFiles(fileState.path);
  } catch (error) {
    toast("保存失败：" + error.message);
  }
};

let actionDialogResolve = null;
let actionDialogPreviousFocus = null;
let actionDialogPrompt = false;
function finishActionDialog(value) {
  const resolve = actionDialogResolve;
  actionDialogResolve = null;
  $("action-dialog").close();
  actionDialogPreviousFocus?.focus();
  resolve?.(value);
}
function actionDialog(description, isPrompt = false) {
  if (actionDialogResolve) return Promise.resolve(isPrompt ? null : false);
  actionDialogPreviousFocus = document.activeElement;
  actionDialogPrompt = isPrompt;
  $("action-title").textContent = isPrompt ? "新建文本文件" : "确认操作";
  $("action-description").textContent = description;
  $("action-input-label").classList.toggle("hidden", !isPrompt);
  $("action-input").value = "";
  $("action-input").required = isPrompt;
  $("action-confirm").textContent = isPrompt ? "创建" : "确认";
  $("action-dialog").showModal();
  (isPrompt ? $("action-input") : $("action-cancel")).focus();
  return new Promise((resolve) => {
    actionDialogResolve = resolve;
  });
}
function confirmAction(description) {
  return actionDialog(description);
}
function promptAction(description) {
  return actionDialog(description, true);
}
$("action-dialog-form").onsubmit = (event) => {
  event.preventDefault();
  finishActionDialog(actionDialogPrompt ? $("action-input").value.trim() : true);
};
$("action-cancel").onclick = () => finishActionDialog(actionDialogPrompt ? null : false);
$("action-dialog").addEventListener("cancel", (event) => {
  event.preventDefault();
  finishActionDialog(actionDialogPrompt ? null : false);
});
