// QQ 桥接安全硬边界：只允许 QQ MCP 工具与少量无害模型侧工具。
//
// 这个文件是 agent preset 内的本地插件，随 preset 装载进每个 QQ agent 的 scope。
// 作用：
//   1) 用 tools.restrict 把已知的开发/管理工具从工具列表隐藏；
//   2) 用 tools.guard 白名单兜底：任何不在白名单里的工具调用都会被拒绝。
//
// 兼容性说明（DSH 0.2.0-rc.2）：
//   `tools.restrict()` 在新版加了严格校验 —— 它要求 **scoped context**，并且
//   被点名的工具必须真实存在（否则抛错）。老实现一次性 try/catch 整批调用，
//   任何一个名字对不上就会让 apply() 抛错、插件报 "never started"，
//   最终整个 preset 挂载失败（表现为 QQ 会话全部无法 resume）。
//   现在改成：逐个 restrict 各自 try/catch；guard 单独 try/catch。
//   即使某个版本没有这些 API，插件也一定能启动成功 —— 安全边界退化为
//   「preset 组合本身不挂载这些工具」，而不是让整个 preset 崩掉。
export const name = 'qq-tool-restrict'

export const inject = ['tools']

// 已知的开发/管理工具（不同 DSH 版本注册的名字可能不同，对不上就跳过）。
const KNOWN_DANGEROUS_GLOBAL_TOOLS = [
  'dev_build_plugin',
  'dev_clear_routes',
  'dev_fix_patch',
  'dev_heal_links',
  'dev_inject_plugin',
  'dev_injected_list',
  'dev_install_package',
  'dev_mode_set',
  'dev_mode_status',
  'dev_mode_subagent',
  'dev_plugin_status',
  'dev_router_mode',
  'dev_router_status',
  'dev_release_plugin',
  'dev_reload_package',
  'dev_scaffold_plugin',
  'dev_self_test',
  'dev_stage_add',
  'dev_stage_call',
  'dev_stage_demote',
  'dev_stage_list',
  'dev_stage_promote',
  'dev_uninject_plugin',
  'wait_agent',
  'create_worktree',
  'plugin_market',
  'session_event_trace',
  'session_event_search',
  'session_event_read',
  'session_trace',
  'session_search',
  'terminal_list',
  'terminal_close',
  'terminal_signal',
  'terminal_read',
  'terminal_send',
  'terminal_open',
  'working_directory',
]

// 执行期白名单：不在这些范围内的工具一律拒绝。
const SAFE_PREFIXES = [
  'mcp__snowluma__',
  'mcp__snowluma-host__',
  'mcp__web-search-safe__',
  'mcp__memory__',
  'mcp__comfy__',
]

// 无害模型侧工具：ask_user_question 用于把问题转给管理员/用户，todo_write 仅维护任务列表。
const SAFE_EXACT = new Set([
  'ask_user_question',
  'todo_write',
])

export function apply(ctx) {
  // 诊断日志：只在显式开启时输出，避免刷正常日志。
  const debug = process.env.QQ_TOOL_RESTRICT_DEBUG === '1'
  const note = (msg) => {
    if (debug) console.error(`[qq-tool-restrict] ${msg}`)
  }

  // 1) 隐藏已知危险的全局工具。
  //    必须逐个 restrict：新版对「名字不存在」会抛错，整批调用会连坐失败。
  let restricted = 0
  for (const toolName of KNOWN_DANGEROUS_GLOBAL_TOOLS) {
    try {
      ctx.tools.restrict({ deny: [toolName] })
      restricted += 1
    } catch (error) {
      // 该工具在本版本不存在（或不接受这批过滤）——跳过，执行期白名单仍兜底。
      note(`skip restrict ${toolName}: ${error?.message ?? error}`)
    }
  }
  note(`restricted ${restricted}/${KNOWN_DANGEROUS_GLOBAL_TOOLS.length} dangerous tools`)

  // 2) 执行期白名单兜底。
  //    返回字符串 = 拒绝原因；返回 undefined = 放行。
  //    guard API 若在某些版本不存在，也不能让插件启动失败。
  try {
    ctx.tools.guard((exec) => {
      const toolName = exec?.name
      if (typeof toolName !== 'string' || toolName.length === 0) return
      if (SAFE_EXACT.has(toolName)) return
      if (SAFE_PREFIXES.some((prefix) => toolName.startsWith(prefix))) return
      return `工具 "${toolName}" 不在 QQ 桥接白名单内，已拒绝（仅允许 QQ MCP 工具与无害模型侧工具）`
    })
    note('guard installed')
  } catch (error) {
    note(`guard unavailable: ${error?.message ?? error}`)
  }
}
