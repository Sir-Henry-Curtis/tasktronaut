import path from "node:path"
import { existsSync } from "fs"
import { chmod, mkdir, writeFile } from "fs/promises"
import { Logger } from "@/shared/services/Logger"
import { GSD_AGENTS } from "../gsd-agents-generated"
import { GSD_RESEARCH_ASSETS } from "../gsd-research-assets-generated"

// Hook scripts embedded as strings so they survive esbuild bundling.
// The installer writes them to <workspace>/.tasktronautrules/hooks/ at activation.

const HOOK_PRE_COMPACT = `#!/usr/bin/env node
// GSD v1.5 PreCompact hook — preserve planning state before context compaction.
const fs = require('fs');
const path = require('path');
let input = '';
const t = setTimeout(() => process.exit(0), 5000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  clearTimeout(t);
  try {
    const data = JSON.parse(input);
    const cwd = data.cwd || (data.workspaceRoots || [])[0] || process.cwd();
    const sp = path.join(cwd, '.planning', 'STATE.md');
    if (!fs.existsSync(sp)) { out(''); process.exit(0); }
    const state = fs.readFileSync(sp, 'utf8').trim();
    let proj = '';
    const pp = path.join(cwd, '.planning', 'PROJECT.md');
    if (fs.existsSync(pp)) proj = '\\n\\n### Project Summary\\n' + fs.readFileSync(pp, 'utf8').slice(0, 500).trim();
    out('## GSD State Checkpoint (saved before compaction)\\n\\n\`\`\`\\n' + state + '\\n\`\`\`' + proj +
      '\\n\\nContinue from current_step after compaction. Run /gsd-next if unsure.');
  } catch (_) { out(''); }
  process.exit(0);
});
function out(c) { process.stdout.write(JSON.stringify({ cancel: false, contextModification: c })); }
`

const HOOK_TASK_START = `#!/usr/bin/env node
// GSD v1.5 TaskStart hook — inject planning context when a new task begins.
const fs = require('fs');
const path = require('path');
let input = '';
const t = setTimeout(() => process.exit(0), 5000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  clearTimeout(t);
  try {
    const data = JSON.parse(input);
    const cwd = data.cwd || (data.workspaceRoots || [])[0] || process.cwd();
    const sp = path.join(cwd, '.planning', 'STATE.md');
    if (!fs.existsSync(sp)) { out(''); process.exit(0); }
    const state = fs.readFileSync(sp, 'utf8').trim();
    const phase = (state.match(/current_phase:\\s*(\\S+)/) || [])[1];
    const step = (state.match(/current_step:\\s*(\\S+)/) || [])[1];
    let plan = '';
    if (phase && (step === 'execute' || step === 'verify')) {
      const pp = path.join(cwd, '.planning', 'PLANS', 'phase-' + String(phase).padStart(2,'0') + '.xml');
      if (fs.existsSync(pp)) {
        const c = fs.readFileSync(pp, 'utf8');
        plan = '\\n\\n### Active Phase Plan\\n\`\`\`xml\\n' + c.slice(0,3000) + (c.length>3000?'\\n...[truncated]':'') + '\\n\`\`\`';
      }
    }
    out('## GSD Project Context\\n\\nA GSD workflow is active. Current state:\\n\\n\`\`\`\\n' + state + '\\n\`\`\`' + plan +
      '\\n\\nUse /gsd-next to advance, or /gsd-<command> for a specific step.');
  } catch (_) { out(''); }
  process.exit(0);
});
function out(c) { process.stdout.write(JSON.stringify({ cancel: false, contextModification: c })); }
`

const HOOK_USER_PROMPT_SUBMIT = `#!/usr/bin/env node
// GSD v1.5 UserPromptSubmit hook — detect /gsd-* and inject planning context.
const fs = require('fs');
const path = require('path');
let input = '';
const t = setTimeout(() => process.exit(0), 5000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  clearTimeout(t);
  try {
    const data = JSON.parse(input);
    const prompt = (data.userPromptSubmit || {}).prompt || '';
    const cwd = data.cwd || (data.workspaceRoots || [])[0] || process.cwd();
    const m = prompt.match(/(^|\\s)\\/gsd-([a-zA-Z0-9-]+)/);
    if (!m) { out(''); process.exit(0); }
    const cmd = 'gsd-' + m[2];
    const pd = path.join(cwd, '.planning');
    let ctx = '## GSD Context for /' + cmd + '\\n\\n';
    const sp = path.join(pd, 'STATE.md');
    let state = '';
    if (fs.existsSync(sp)) {
      state = fs.readFileSync(sp, 'utf8').trim();
      ctx += '### Current State\\n\`\`\`\\n' + state + '\\n\`\`\`\\n\\n';
    } else if (!cmd.includes('new-project')) {
      ctx += '### No GSD Project\\nRun /gsd-new-project to initialize.\\n\\n';
    }
    if (cmd.includes('execute') || cmd.includes('plan') || cmd.includes('verify')) {
      const ph = (state.match(/current_phase:\\s*(\\S+)/) || [])[1];
      if (ph) {
        const pp = path.join(pd, 'PLANS', 'phase-' + String(ph).padStart(2,'0') + '.xml');
        if (fs.existsSync(pp)) {
          const c = fs.readFileSync(pp, 'utf8');
          ctx += '### Phase ' + ph + ' Plan\\n\`\`\`xml\\n' + c.slice(0,4000) + (c.length>4000?'\\n...[truncated]':'') + '\\n\`\`\`\\n\\n';
        }
      }
    }
    if (cmd.includes('discuss') || cmd.includes('next') || cmd.includes('new-project')) {
      const rp = path.join(pd, 'ROADMAP.md');
      if (fs.existsSync(rp)) {
        const r = fs.readFileSync(rp, 'utf8');
        ctx += '### Roadmap\\n' + r.slice(0,2000) + (r.length>2000?'\\n...[truncated]':'') + '\\n\\n';
      }
    }
    out(ctx);
  } catch (_) { out(''); }
  process.exit(0);
});
function out(c) { process.stdout.write(JSON.stringify({ cancel: false, contextModification: c })); }
`

const HOOK_POST_TOOL_USE = `#!/usr/bin/env node
// GSD v1.5 PostToolUse hook — detect stuck loops from repetitive file writes.
const fs = require('fs');
const os = require('os');
const path = require('path');
const WARN_AT = 3;
let input = '';
const t = setTimeout(() => process.exit(0), 5000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  clearTimeout(t);
  try {
    const data = JSON.parse(input);
    const sid = data.session_id;
    const tool = (data.postToolUse || {}).tool_name || '';
    if (!['write_to_file','apply_diff','str_replace_editor','create_file'].includes(tool)) { out(''); process.exit(0); }
    const fp = ((data.postToolUse || {}).tool_input || {}).path ||
               ((data.postToolUse || {}).tool_input || {}).file_path || '';
    if (!fp || !sid || /[\\/\\\\]|\\.\\."/.test(sid)) { out(''); process.exit(0); }
    const tmp = path.join(os.tmpdir(), 'gsd-writes-' + sid + '.json');
    let w = {};
    try { if (fs.existsSync(tmp)) w = JSON.parse(fs.readFileSync(tmp,'utf8')); } catch(_){}
    w[fp] = (w[fp] || 0) + 1;
    try { fs.writeFileSync(tmp, JSON.stringify(w)); } catch(_){}
    if (w[fp] >= WARN_AT) {
      out('## GSD Loop Warning\\n\\n\`' + fp + '\` written **' + w[fp] + ' times** this session.\\n\\n' +
        '**Actions:**\\n1. Verify output meets acceptance criteria.\\n' +
        '2. Run /gsd-verify-work to check criteria.\\n' +
        '3. If blocked: document in STATE.md and ask user for input.');
    } else { out(''); }
  } catch(_) { out(''); }
  process.exit(0);
});
function out(c) { process.stdout.write(JSON.stringify({ cancel: false, contextModification: c })); }
`

const GSD_SDK_SHIM = `#!/usr/bin/env node
// gsd-sdk shim — bundled with Tasktronaut. Implements gsd-sdk query commands
// using pure filesystem/git so workflows run without the get-shit-done-cc npm package.
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const args = process.argv.slice(2);
const subcmd = args[0];
if (subcmd !== 'query') { process.stderr.write('gsd-sdk shim: only "query" is supported\\n'); process.exit(0); }

const query = args[1];
const rest = args.slice(2);
const cwd = process.cwd();

function exists(p, type) {
  try { const s = fs.statSync(p); return type === 'd' ? s.isDirectory() : s.isFile(); } catch { return false; }
}
function hasCode(dir, depth) {
  if (depth > 3) return false;
  const skip = new Set(['node_modules', '.git', '.planning', 'dist', 'build']);
  try {
    for (const ent of fs.readdirSync(dir)) {
      if (skip.has(ent)) continue;
      const full = path.join(dir, ent);
      const s = fs.statSync(full);
      if (s.isFile() && /\\.(ts|tsx|js|jsx|py|go|rs|rb|java|cs|cpp|c)$/.test(ent)) return true;
      if (s.isDirectory() && hasCode(full, depth + 1)) return true;
    }
  } catch { return false; }
  return false;
}
function safeReadJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return fallback; }
}
function listSubagentExecutionRuns() {
  const registryPath = path.join(cwd, '.tasktronaut', 'runtime', 'subagent-executions.json');
  const registry = safeReadJson(registryPath, { runs: [] });
  return Array.isArray(registry.runs) ? registry.runs : [];
}
function parseFlagValues(argv, flagName) {
  const values = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flagName && argv[i + 1] != null) {
      values.push(String(argv[i + 1]));
      i += 1;
    }
  }
  return values;
}
function filterSubagentExecutionRuns(argv) {
  const roleFilters = parseFlagValues(argv, '--role');
  const phaseFilters = parseFlagValues(argv, '--phase');
  const planFilters = parseFlagValues(argv, '--plan');
  const statusValues = parseFlagValues(argv, '--status');
  const statusFilters = statusValues.flatMap((value) => String(value).split(',')).map((value) => value.trim()).filter(Boolean);
  const worktreeOnly = argv.includes('--worktree-only');
  const activeOnly = argv.includes('--active-only');
  const runs = listSubagentExecutionRuns();
  return runs.filter((run) => {
    if (!run || typeof run !== 'object') return false;
    if (roleFilters.length > 0 && !roleFilters.includes(String(run.role || ''))) return false;
    if (phaseFilters.length > 0 && !phaseFilters.includes(String(run.phase_number || ''))) return false;
    if (planFilters.length > 0 && !planFilters.includes(String(run.plan_id || ''))) return false;
    if (statusFilters.length > 0 && !statusFilters.includes(String(run.status || ''))) return false;
    if (worktreeOnly && String(run.isolation || '') !== 'worktree') return false;
    if (activeOnly && !['running', 'completed'].includes(String(run.status || ''))) return false;
    return true;
  }).sort((left, right) => Number(right.updated_at_unix_ms || 0) - Number(left.updated_at_unix_ms || 0));
}
function getTodayDate() {
  return new Date().toISOString().slice(0, 10);
}
function getInstalledAgentStatus(requiredAgents) {
  const agentsDir = path.join(cwd, '.tasktronaut', 'agents');
  const missingAgents = requiredAgents.filter((agent) => !exists(path.join(agentsDir, agent + '.md'), 'f'));
  return { agents_installed: missingAgents.length === 0, missing_agents: missingAgents };
}
function listExistingMaps() {
  const codebaseDir = path.join(cwd, '.planning', 'codebase');
  if (!exists(codebaseDir, 'd')) return [];
  try {
    return fs.readdirSync(codebaseDir).filter((name) => name.endsWith('.md'));
  } catch { return []; }
}
function getResearchEnabled() {
  const cfg = safeReadJson(path.join(cwd, '.planning', 'config.json'), {});
  const workflowCfg = cfg.workflow || {};
  return workflowCfg.research !== false;
}
function countPhaseDirs() {
  const phasesDir = path.join(cwd, '.planning', 'phases');
  if (!exists(phasesDir, 'd')) return 0;
  try {
    return fs.readdirSync(phasesDir)
      .filter((name) => exists(path.join(phasesDir, name), 'd'))
      .length;
  } catch { return 0; }
}
function getLatestCompletedMilestone() {
  const milestonesPath = path.join(cwd, '.planning', 'MILESTONES.md');
  if (!exists(milestonesPath, 'f')) return '';
  const content = fs.readFileSync(milestonesPath, 'utf8');
  const matches = Array.from(content.matchAll(/^##s+(vd+(?:.d+)*)\b/gm));
  return matches.length > 0 ? matches[matches.length - 1][1] : '';
}
function normalizePhaseNumber(rawPhase) {
  const phase = String(rawPhase || '').trim();
  if (!phase) return '';
  if (/^d+$/.test(phase)) return String(Number(phase)).padStart(2, '0');
  const decimalMatch = phase.match(/^(d+).(d+)$/);
  if (decimalMatch) return String(Number(decimalMatch[1])).padStart(2, '0') + '.' + decimalMatch[2];
  return phase;
}
function findPhaseDirectory(rawPhase) {
  const normalized = normalizePhaseNumber(rawPhase);
  const phasesDir = path.join(cwd, '.planning', 'phases');
  if (!normalized || !exists(phasesDir, 'd')) {
    return { found: false, normalized, phaseDir: '', phaseName: '', phaseSlug: '' };
  }
  try {
    const entry = fs.readdirSync(phasesDir).find((name) => name.startsWith(normalized + '-'));
    if (!entry) {
      return { found: false, normalized, phaseDir: '', phaseName: '', phaseSlug: '' };
    }
    const phaseSlug = entry.slice((normalized + '-').length);
    const phaseName = phaseSlug.replace(/-/g, ' ').trim();
    return {
      found: true,
      normalized,
      phaseDir: path.join('.planning', 'phases', entry),
      phaseName,
      phaseSlug,
    };
  } catch {
    return { found: false, normalized, phaseDir: '', phaseName: '', phaseSlug: '' };
  }
}
function firstExistingPath(paths) {
  for (const candidate of paths) {
    if (candidate && exists(path.join(cwd, candidate), 'f')) return candidate;
  }
  return null;
}
function readConfig() {
  const cfg = safeReadJson(path.join(cwd, '.planning', 'config.json'), {});
  const workflowCfg = cfg.workflow && typeof cfg.workflow === 'object' ? cfg.workflow : {};
  const workflowDefaults = {
    research: workflowCfg.research !== false,
    plan_check: workflowCfg.plan_check !== false,
    nyquist_validation: workflowCfg.nyquist_validation !== false,
    text_mode: workflowCfg.text_mode === true,
    auto_advance: workflowCfg.auto_advance === true,
    auto_chain_active: workflowCfg._auto_chain_active === true,
    _auto_chain_active: workflowCfg._auto_chain_active === true,
    discuss_mode: workflowCfg.discuss_mode || 'discuss',
    ai_integration_phase: workflowCfg.ai_integration_phase !== false,
    ui_phase: workflowCfg.ui_phase !== false,
    ui_safety_gate: workflowCfg.ui_safety_gate !== false,
    pattern_mapper: workflowCfg.pattern_mapper !== false,
    tdd_mode: workflowCfg.tdd_mode === true,
    plan_chunked: workflowCfg.plan_chunked === true,
    security_enforcement: workflowCfg.security_enforcement !== false,
    security_asvs_level: workflowCfg.security_asvs_level == null ? 1 : workflowCfg.security_asvs_level,
    security_block_on: workflowCfg.security_block_on || 'high',
    context_coverage_gate: workflowCfg.context_coverage_gate !== false,
    post_planning_gaps: workflowCfg.post_planning_gaps !== false,
    plan_bounce_passes: workflowCfg.plan_bounce_passes == null ? 2 : workflowCfg.plan_bounce_passes,
    plan_bounce_script: workflowCfg.plan_bounce_script || '',
  };
  return {
    ...cfg,
    workflow: {
      ...workflowDefaults,
      ...workflowCfg,
      _auto_chain_active: workflowDefaults._auto_chain_active,
    },
    commit_docs: cfg.commit_docs !== false,
    context_window: cfg.context_window == null ? 200000 : cfg.context_window,
    response_language: cfg.response_language == null ? null : cfg.response_language,
    workflowDefaults,
  };
}
function getConfigValue(pathKey, defaultValue) {
  const cfg = readConfig();
  const keys = String(pathKey || '').split('.').filter(Boolean);
  let value = cfg;
  for (const key of keys) {
    if (!value || typeof value !== 'object' || !(key in value)) return defaultValue;
    value = value[key];
  }
  return value == null ? defaultValue : value;
}
function getConfigFlag(pathKey, defaultValue) {
  const value = getConfigValue(pathKey, defaultValue);
  return typeof value === 'boolean' ? value : defaultValue;
}
function parseDefaultValue(value) {
  if (value == null) return '';
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (value === 'undefined') return undefined;
  if (/^-?\\d+(?:\\.\\d+)?$/.test(String(value))) return Number(value);
  return value;
}
function formatScalar(value) {
  if (value == null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
function parseRoadmapPhase(rawPhase) {
  const roadmapPath = path.join(cwd, '.planning', 'ROADMAP.md');
  if (!exists(roadmapPath, 'f')) return null;
  const content = fs.readFileSync(roadmapPath, 'utf8');
  const phaseText = String(rawPhase || '').trim();
  if (!phaseText) return null;
  const numeric = /^\\d+$/.test(phaseText);
  const canonical = numeric ? String(Number(phaseText)) : phaseText;
  const escaped = canonical.replace(/[.*+?^$(){}|[\\]\\\\]/g, '\\\\$&');
  const phasePattern = numeric
    ? new RegExp('^#{2,4}\\\\s*Phase\\\\s+0*' + escaped + ':\\\\s*([^\\\\n]+)$', 'im')
    : new RegExp('^#{2,4}\\\\s*Phase\\\\s+' + escaped + ':\\\\s*([^\\\\n]+)$', 'im');
  const headerMatch = content.match(phasePattern);
  if (!headerMatch || headerMatch.index == null) return null;
  const headerIndex = headerMatch.index;
  const restOfContent = content.slice(headerIndex);
  const nextHeaderMatch = restOfContent.slice(1).match(/\\n#{2,4}\\s+Phase\\s+[\\w]/i);
  const sectionEnd = nextHeaderMatch ? headerIndex + 1 + nextHeaderMatch.index : content.length;
  const section = content.slice(headerIndex, sectionEnd).trim();
  const phaseName = headerMatch[1].trim();
  const goalMatch = section.match(/\\*\\*Goal(?:\\*\\*:|\\*?\\*?:\\*\\*)\\s*([^\\n]+)/i);
  const requirementsMatch = section.match(/^\\*\\*Requirements:?\\*\\*[^\\S\\n]*:?[^\\n]*$/im);
  const reqValue = requirementsMatch
    ? requirementsMatch[0].replace(/^\\*\\*Requirements:?\\*\\*[^\\S\\n]*:?\\s*/i, '').trim()
    : null;
  const phaseReqIds = reqValue && reqValue !== 'TBD'
    ? reqValue.replace(/[\\[\\]]/g, '').split(',').map((item) => item.trim()).filter(Boolean).join(', ')
    : null;
  return {
    found: true,
    phase_number: numeric ? canonical : phaseText,
    phase_name: phaseName,
    phase_slug: slugify(phaseName),
    goal: goalMatch ? goalMatch[1].trim() : null,
    section,
    phase_req_ids: phaseReqIds,
  };
}
function getPhaseArtifacts(phaseDir, normalizedPhase) {
  if (!phaseDir || !exists(path.join(cwd, phaseDir), 'd')) {
    return {
      context_path: null,
      research_path: null,
      verification_path: null,
      uat_path: null,
      reviews_path: null,
      patterns_path: null,
      has_context: false,
      has_research: false,
      has_reviews: false,
      has_plans: false,
      plan_count: 0,
    };
  }
  const prefixed = normalizedPhase ? normalizedPhase + '-' : '';
  const resolveArtifact = (suffix) => firstExistingPath([
    path.join(phaseDir, prefixed + suffix),
    path.join(phaseDir, suffix),
  ]);
  const planFiles = fs.readdirSync(path.join(cwd, phaseDir))
    .filter((name) => /-PLAN\\.md$/.test(name));
  const contextPath = resolveArtifact('CONTEXT.md');
  const researchPath = resolveArtifact('RESEARCH.md');
  const reviewsPath = resolveArtifact('REVIEWS.md');
  return {
    context_path: contextPath,
    research_path: researchPath,
    verification_path: resolveArtifact('VERIFICATION.md'),
    uat_path: resolveArtifact('UAT.md'),
    reviews_path: reviewsPath,
    patterns_path: resolveArtifact('PATTERNS.md'),
    has_context: contextPath != null,
    has_research: researchPath != null,
    has_reviews: reviewsPath != null,
    has_plans: planFiles.length > 0,
    plan_count: planFiles.length,
  };
}
function getStateField(fieldName) {
  const statePath = path.join(cwd, '.planning', 'STATE.md');
  if (!exists(statePath, 'f')) return '';
  const content = fs.readFileSync(statePath, 'utf8');
  const match = content.match(new RegExp('^' + fieldName.replace(/[.*+?^$(){}|[\\]\\\\]/g, '\\\\$&') + ':\\\\s*(.+)$', 'm'));
  return match ? match[1].trim() : '';
}
function comparePhaseValues(a, b) {
  return String(a || '').localeCompare(String(b || ''), undefined, { numeric: true, sensitivity: 'base' });
}
function resolveProjectPath(relPath) {
  const resolved = path.resolve(cwd, relPath);
  if (resolved === cwd || resolved.startsWith(cwd + path.sep)) return resolved;
  throw new Error('Path escapes project root: ' + relPath);
}
function parseFrontmatter(content) {
  const match = content.match(/^---\\r?\\n([\\s\\S]*?)\\r?\\n---\\r?\\n?/);
  if (!match) return {};
  const result = {};
  let currentKey = null;
  for (const rawLine of match[1].split(/\\r?\\n/)) {
    const line = rawLine.replace(/\\t/g, '    ');
    const fieldMatch = line.match(/^([A-Za-z0-9_-]+):\\s*(.*)$/);
    if (fieldMatch) {
      currentKey = fieldMatch[1];
      const rawValue = fieldMatch[2].trim();
      if (!rawValue) {
        result[currentKey] = [];
      } else if (rawValue === 'true') {
        result[currentKey] = true;
      } else if (rawValue === 'false') {
        result[currentKey] = false;
      } else if (/^-?\\d+$/.test(rawValue)) {
        result[currentKey] = Number(rawValue);
      } else {
        result[currentKey] = rawValue;
      }
      continue;
    }
    const itemMatch = line.match(/^\\s*-\\s*(.+?)\\s*$/);
    if (itemMatch && currentKey) {
      if (!Array.isArray(result[currentKey])) result[currentKey] = [];
      result[currentKey].push(itemMatch[1].trim());
    }
  }
  return result;
}
function extractObjective(content) {
  const blockMatch = content.match(/<objective>\\s*([\\s\\S]*?)<[/]objective>/i);
  if (blockMatch) return blockMatch[1].trim();
  const lineMatch = content.match(/<objective>\\s*\\n?\\s*(.+)/i);
  return lineMatch ? lineMatch[1].trim() : null;
}
function getPlanTaskCount(content) {
  const xmlTasks = content.match(/<task[\\s>]/gi) || [];
  const markdownTasks = content.match(/##\\s*Task\\s*\\d+/gi) || [];
  return xmlTasks.length || markdownTasks.length;
}
function getFrontmatterList(frontmatter, primaryKey, secondaryKey) {
  const value = frontmatter[primaryKey] != null ? frontmatter[primaryKey] : frontmatter[secondaryKey];
  if (Array.isArray(value)) return value.map((entry) => String(entry).trim()).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}
function extractKeyLinks(content) {
  const match = content.match(/^---\\r?\\n([\\s\\S]*?)\\r?\\n---\\r?\\n?/);
  if (!match) return [];
  const lines = match[1].split(/\\r?\\n/);
  const links = [];
  let inMustHaves = false;
  let inKeyLinks = false;
  let current = null;
  for (const line of lines) {
    if (!/^\\s/.test(line) && /^must_haves:\\s*$/.test(line)) {
      inMustHaves = true;
      inKeyLinks = false;
      current = null;
      continue;
    }
    if (inMustHaves && !/^\\s/.test(line) && !/^must_haves:\\s*$/.test(line)) {
      inMustHaves = false;
      inKeyLinks = false;
      current = null;
    }
    if (!inMustHaves) continue;
    if (/^\\s*key_links:\\s*$/.test(line)) {
      inKeyLinks = true;
      current = null;
      continue;
    }
    if (!inKeyLinks) continue;
    const fromMatch = line.match(/^\\s*-\\s*from:\\s*(.+?)\\s*$/);
    if (fromMatch) {
      if (current) links.push(current);
      current = { from: fromMatch[1].trim(), to: '', via: '', pattern: '' };
      continue;
    }
    const fieldMatch = line.match(/^\\s*(to|via|pattern):\\s*(.+?)\\s*$/);
    if (fieldMatch && current) {
      current[fieldMatch[1]] = fieldMatch[2].trim();
      continue;
    }
    if (/^\\s{2,}[A-Za-z0-9_-]+:\\s*$/.test(line) && !/^\\s*key_links:\\s*$/.test(line)) {
      if (current) links.push(current);
      current = null;
      inKeyLinks = false;
    }
  }
  if (current) links.push(current);
  return links;
}
function getPhaseDirectoryInfo(rawPhase) {
  const phaseInfo = findPhaseDirectory(rawPhase);
  if (!phaseInfo.found) return null;
  const phaseDirAbs = path.join(cwd, phaseInfo.phaseDir);
  const phaseFiles = fs.readdirSync(phaseDirAbs);
  return { phaseInfo, phaseDirAbs, phaseFiles };
}
function getPhasePlanIndexData(rawPhase) {
  const directoryInfo = getPhaseDirectoryInfo(rawPhase);
  const normalized = normalizePhaseNumber(rawPhase);
  if (!directoryInfo) {
    return {
      phase: normalized,
      phase_dir: null,
      phase_name: '',
      phase_slug: '',
      plans: [],
      plan_files: [],
      summary_files: [],
      waves: {},
      incomplete: [],
      incomplete_plan_files: [],
      has_checkpoints: false,
      error: 'Phase not found',
    };
  }
  const { phaseInfo, phaseDirAbs, phaseFiles } = directoryInfo;
  const planFiles = phaseFiles.filter((name) => /-PLAN\\.md$/.test(name) || name === 'PLAN.md').sort(comparePhaseValues);
  const summaryFiles = phaseFiles.filter((name) => /-SUMMARY\\.md$/.test(name) || name === 'SUMMARY.md');
  const completedPlanIds = new Set(summaryFiles.map((name) => name === 'SUMMARY.md' ? 'PLAN' : name.replace(/-SUMMARY\\.md$/, '')));
  const plans = [];
  const waves = {};
  const incomplete = [];
  const incompletePlanFiles = [];
  let hasCheckpoints = false;
  for (const planFile of planFiles) {
    const planId = planFile === 'PLAN.md' ? 'PLAN' : planFile.replace(/-PLAN\\.md$/, '');
    const content = fs.readFileSync(path.join(phaseDirAbs, planFile), 'utf8');
    const frontmatter = parseFrontmatter(content);
    const wave = parseInt(String(frontmatter.wave), 10) || 1;
    const autonomous = frontmatter.autonomous === undefined
      ? true
      : !(frontmatter.autonomous === false || String(frontmatter.autonomous).trim().toLowerCase() === 'false');
    if (!autonomous || /<task\\s+type=["']?checkpoint/i.test(content)) {
      hasCheckpoints = true;
    }
    const filesModified = getFrontmatterList(frontmatter, 'files_modified', 'files-modified');
    const hasSummary = completedPlanIds.has(planId);
    if (!hasSummary) {
      incomplete.push(planId);
      incompletePlanFiles.push(planFile);
    }
    plans.push({
      id: planId,
      wave,
      autonomous,
      objective: extractObjective(content) || (typeof frontmatter.objective === 'string' ? frontmatter.objective : null),
      files_modified: filesModified,
      task_count: getPlanTaskCount(content),
      has_summary: hasSummary,
    });
    const waveKey = String(wave);
    if (!waves[waveKey]) waves[waveKey] = [];
    waves[waveKey].push(planId);
  }
  return {
    phase: phaseInfo.normalized || normalized,
    phase_dir: phaseInfo.phaseDir,
    phase_name: phaseInfo.phaseName || '',
    phase_slug: phaseInfo.phaseSlug || '',
    plans,
    plan_files: planFiles,
    summary_files: summaryFiles.sort(comparePhaseValues),
    waves,
    incomplete,
    incomplete_plan_files: incompletePlanFiles,
    has_checkpoints: hasCheckpoints,
  };
}
function computeBranchName(config, branchingStrategy, phaseNumber, phaseSlug) {
  const gitCfg = config && typeof config.git === 'object' ? config.git : {};
  const projectCode = typeof config.project_code === 'string' ? config.project_code : '';
  if (branchingStrategy === 'phase' && phaseNumber) {
    const template = typeof gitCfg.phase_branch_template === 'string' && gitCfg.phase_branch_template
      ? gitCfg.phase_branch_template
      : '{project}phase-{phase}-{slug}';
    return template
      .replace('{project}', projectCode ? projectCode + '-' : '')
      .replace('{phase}', phaseNumber)
      .replace('{slug}', phaseSlug || 'phase');
  }
  return null;
}
function findNextPhaseInfo(currentPhase) {
  const normalizedCurrent = normalizePhaseNumber(currentPhase);
  const candidates = [];
  const phasesDir = path.join(cwd, '.planning', 'phases');
  if (exists(phasesDir, 'd')) {
    for (const name of fs.readdirSync(phasesDir)) {
      const match = name.match(/^([0-9]+(?:\\.[0-9]+)*)-(.+)$/);
      if (!match) continue;
      candidates.push({ phase: normalizePhaseNumber(match[1]), name: match[2].replace(/-/g, ' ') });
    }
  }
  const roadmapPath = path.join(cwd, '.planning', 'ROADMAP.md');
  if (exists(roadmapPath, 'f')) {
    const roadmapContent = fs.readFileSync(roadmapPath, 'utf8');
    const phasePattern = /^#{2,4}\\s*Phase\\s+([0-9]+(?:\\.[0-9]+)*)\\s*:\\s*([^\\n]+)/gim;
    let match;
    while ((match = phasePattern.exec(roadmapContent)) !== null) {
      candidates.push({ phase: normalizePhaseNumber(match[1]), name: match[2].replace(/\\(INSERTED\\)/gi, '').trim() });
    }
  }
  const deduped = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate.phase || seen.has(candidate.phase)) continue;
    seen.add(candidate.phase);
    deduped.push(candidate);
  }
  deduped.sort((a, b) => comparePhaseValues(a.phase, b.phase));
  return deduped.find((candidate) => comparePhaseValues(candidate.phase, normalizedCurrent) > 0) || null;
}
function upsertLine(source, key, value) {
  const line = key + ': ' + value;
  const pattern = new RegExp('^' + key.replace(/[.*+?^$(){}|[\\]\\\\]/g, '\\\\$&') + ':.*$', 'm');
  return pattern.test(source)
    ? source.replace(pattern, line)
    : (source.trimEnd() + (source.trim() ? '\\n' : '') + line + '\\n');
}
function updateStateForExecution(phaseValue, phaseName, plansValue) {
  const statePath = path.join(cwd, '.planning', 'STATE.md');
  let content = exists(statePath, 'f') ? fs.readFileSync(statePath, 'utf8') : '';
  content = upsertLine(content, 'current_phase', phaseValue);
  content = upsertLine(content, 'current_phase_name', phaseName || '');
  content = upsertLine(content, 'current_step', 'execute');
  content = upsertLine(content, 'total_plans_in_phase', plansValue);
  content = upsertLine(content, 'last_activity', new Date().toISOString());
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, content, 'utf8');
}
function readPhaseRequirementIds(rawPhase) {
  const roadmapPhase = parseRoadmapPhase(rawPhase);
  if (!roadmapPhase || !roadmapPhase.phase_req_ids) return [];
  return String(roadmapPhase.phase_req_ids).split(',').map((item) => item.trim()).filter(Boolean);
}
function updateRoadmapPlanProgress(rawPhase) {
  const phaseData = getPhasePlanIndexData(rawPhase);
  const roadmapPath = path.join(cwd, '.planning', 'ROADMAP.md');
  if (!phaseData.phase_dir || !exists(roadmapPath, 'f')) {
    return {
      updated: false,
      reason: !phaseData.phase_dir ? 'Phase not found' : 'ROADMAP.md not found',
      plan_count: phaseData.plan_files.length,
      summary_count: phaseData.summary_files.length,
    };
  }
  const phaseNumber = phaseData.phase;
  const planCount = phaseData.plan_files.length;
  const summaryCount = phaseData.summary_files.length;
  const isComplete = planCount > 0 && summaryCount >= planCount;
  const status = isComplete ? 'Complete' : summaryCount > 0 ? 'In Progress' : 'Planned';
  const today = new Date().toISOString().split('T')[0];
  let roadmapContent = fs.readFileSync(roadmapPath, 'utf8');
  const phaseEscaped = phaseNumber.replace(/[.*+?^$(){}|[\\]\\\\]/g, '\\\\$&');
  const tableRowPattern = new RegExp('^(\\\\|\\\\s*' + phaseEscaped + '\\\\.?\\\\s[^|]*(?:\\\\|[^\\\\n]*))$', 'im');
  roadmapContent = roadmapContent.replace(tableRowPattern, (fullRow) => {
    const cells = fullRow.split('|').slice(1, -1);
    if (cells.length === 5) {
      cells[2] = ' ' + summaryCount + '/' + planCount + ' ';
      cells[3] = ' ' + status.padEnd(11) + ' ';
      cells[4] = isComplete ? ' ' + today + ' ' : '  ';
    } else if (cells.length === 4) {
      cells[1] = ' ' + summaryCount + '/' + planCount + ' ';
      cells[2] = ' ' + status.padEnd(11) + ' ';
      cells[3] = isComplete ? ' ' + today + ' ' : '  ';
    }
    return '|' + cells.join('|') + '|';
  });
  const planCountPattern = new RegExp('(#{2,4}\\\\s*Phase\\\\s+' + phaseEscaped + '(?:(?!\\\\n#{2,4})[\\\\s\\\\S])*?\\\\*\\\\*Plans:\\\\*\\\\*[ \\\\t]*)[^\\\\n]+', 'i');
  roadmapContent = roadmapContent.replace(planCountPattern, '$1' + (isComplete ? summaryCount + '/' + planCount + ' plans complete' : summaryCount + '/' + planCount + ' plans executed'));
  for (const summaryFile of phaseData.summary_files) {
    const planId = summaryFile === 'SUMMARY.md' ? 'PLAN' : summaryFile.replace(/-SUMMARY\\.md$/, '');
    const planEscaped = planId.replace(/[.*+?^$(){}|[\\]\\\\]/g, '\\\\$&');
    const planCheckboxPattern = new RegExp('(-\\\\s*\\\\[) (\\\\]\\\\s*(?:\\\\*\\\\*)?' + planEscaped + '(?:\\\\*\\\\*)?)', 'i');
    roadmapContent = roadmapContent.replace(planCheckboxPattern, '$1x$2');
  }
  fs.writeFileSync(roadmapPath, roadmapContent, 'utf8');
  return {
    updated: true,
    phase: phaseNumber,
    plan_count: planCount,
    summary_count: summaryCount,
    status,
    complete: isComplete,
  };
}

switch (query) {
  case 'init.new-project': {
    const hasGit = exists(path.join(cwd, '.git'), 'd');
    const planningExists = exists(path.join(cwd, '.planning'), 'd');
    const projectExists = exists(path.join(cwd, '.planning', 'PROJECT.md'), 'f');
    const hasCbMap = exists(path.join(cwd, '.planning', 'codebase', 'ARCHITECTURE.md'), 'f');
    const hasPkg = exists(path.join(cwd, 'package.json'), 'f');
    const hasExisting = hasCode(cwd, 0);
    const isBrownfield = hasExisting && !planningExists;
    const needsMap = isBrownfield && !hasCbMap;
    const model = 'claude-sonnet-4-6';
    const agentStatus = getInstalledAgentStatus(['gsd-project-researcher', 'gsd-research-synthesizer', 'gsd-roadmapper']);
    process.stdout.write(JSON.stringify({
      researcher_model: model, synthesizer_model: model, roadmapper_model: model,
      commit_docs: true, project_exists: projectExists, has_codebase_map: hasCbMap,
      planning_exists: planningExists, has_existing_code: hasExisting, has_package_file: hasPkg,
      is_brownfield: isBrownfield, needs_codebase_map: needsMap, has_git: hasGit,
      project_path: '.planning/PROJECT.md', task_tool_available: false, date: getTodayDate(),
      ...agentStatus,
    }));
    break;
  }
  case 'init.map-codebase': {
    const model = 'claude-sonnet-4-6';
    const existingMaps = listExistingMaps();
    const codebaseDirExists = exists(path.join(cwd, '.planning', 'codebase'), 'd');
    const agentStatus = getInstalledAgentStatus(['gsd-codebase-mapper']);
    process.stdout.write(JSON.stringify({
      mapper_model: model,
      commit_docs: true,
      codebase_dir: '.planning/codebase',
      existing_maps: existingMaps,
      has_maps: existingMaps.length > 0,
      codebase_dir_exists: codebaseDirExists,
      subagent_timeout: 300000,
      date: getTodayDate(),
      task_tool_available: false,
      ...agentStatus,
    }));
    break;
  }
  case 'init.new-milestone': {
    const model = 'claude-sonnet-4-6';
    const phaseDirCount = countPhaseDirs();
    const agentStatus = getInstalledAgentStatus(['gsd-project-researcher', 'gsd-research-synthesizer', 'gsd-roadmapper']);
    process.stdout.write(JSON.stringify({
      researcher_model: model,
      synthesizer_model: model,
      roadmapper_model: model,
      commit_docs: true,
      research_enabled: getResearchEnabled(),
      current_milestone: '',
      project_exists: exists(path.join(cwd, '.planning', 'PROJECT.md'), 'f'),
      roadmap_exists: exists(path.join(cwd, '.planning', 'ROADMAP.md'), 'f'),
      latest_completed_milestone: getLatestCompletedMilestone(),
      phase_dir_count: phaseDirCount,
      phase_archive_path: phaseDirCount > 0 ? '.planning/archive/phases-' + Date.now() : '',
      task_tool_available: false,
      ...agentStatus,
    }));
    break;
  }
  case 'init.phase-op': {
    const stateFile = path.join(cwd, '.planning', 'STATE.md');
    const roadmapFile = path.join(cwd, '.planning', 'ROADMAP.md');
    const stateContent = exists(stateFile, 'f') ? fs.readFileSync(stateFile, 'utf8') : '';
    const currentPhase = (stateContent.match(/current_phase:\\s*(\\S+)/) || [])[1] || '1';
    const model = 'claude-sonnet-4-6';
    const config = readConfig();
    const agentStatus = getInstalledAgentStatus(['gsd-phase-researcher']);
    const phaseInfo = findPhaseDirectory(rest[0] || currentPhase);
    const contextPath = phaseInfo.found
      ? firstExistingPath([
          path.join(phaseInfo.phaseDir, phaseInfo.normalized + '-CONTEXT.md'),
          path.join(phaseInfo.phaseDir, 'CONTEXT.md'),
        ])
      : null;
    const researchPath = phaseInfo.found
      ? firstExistingPath([
          path.join(phaseInfo.phaseDir, phaseInfo.normalized + '-RESEARCH.md'),
          path.join(phaseInfo.phaseDir, 'RESEARCH.md'),
        ])
      : null;
    process.stdout.write(JSON.stringify({
      phase: rest[0] || '1', current_phase: currentPhase,
      phase_found: phaseInfo.found,
      phase_dir: phaseInfo.found ? phaseInfo.phaseDir : null,
      phase_number: phaseInfo.normalized || normalizePhaseNumber(rest[0] || currentPhase),
      padded_phase: phaseInfo.normalized || normalizePhaseNumber(rest[0] || currentPhase),
      phase_name: phaseInfo.phaseName || '',
      phase_slug: phaseInfo.phaseSlug || '',
      researcher_model: model, advisor_model: model,
      roadmap_exists: exists(roadmapFile, 'f'), state_exists: exists(stateFile, 'f'),
      state_path: exists(stateFile, 'f') ? '.planning/STATE.md' : null,
      roadmap_path: exists(roadmapFile, 'f') ? '.planning/ROADMAP.md' : null,
      requirements_path: exists(path.join(cwd, '.planning', 'REQUIREMENTS.md'), 'f') ? '.planning/REQUIREMENTS.md' : null,
      context_path: contextPath,
      research_path: researchPath,
      commit_docs: config.commit_docs,
      text_mode: config.workflowDefaults.text_mode,
      planning_exists: exists(path.join(cwd, '.planning'), 'd'),
      brave_search: getConfigFlag('search.brave_search', false),
      exa_search: getConfigFlag('search.exa_search', false),
      firecrawl: getConfigFlag('search.firecrawl', false),
      task_tool_available: false,
      ...agentStatus,
    }));
    break;
  }
  case 'init.plan-phase': {
    const config = readConfig();
    const requestedPhase = rest[0] || getStateField('current_phase') || '1';
    const model = 'claude-sonnet-4-6';
    const roadmapPhase = parseRoadmapPhase(requestedPhase);
    const phaseDirMatch = findPhaseDirectory(requestedPhase);
    const normalizedPhase = phaseDirMatch.normalized || normalizePhaseNumber(roadmapPhase?.phase_number || requestedPhase);
    const phaseDir = phaseDirMatch.found
      ? phaseDirMatch.phaseDir
      : roadmapPhase
        ? path.join('.planning', 'phases', normalizedPhase + '-' + roadmapPhase.phase_slug)
        : null;
    const artifacts = getPhaseArtifacts(phaseDir, normalizedPhase);
    const phaseFound = phaseDirMatch.found || !!roadmapPhase;
    const agentStatus = getInstalledAgentStatus([
      'gsd-phase-researcher',
      'gsd-pattern-mapper',
      'gsd-planner',
      'gsd-plan-checker',
    ]);
    const result = {
      researcher_model: model,
      planner_model: model,
      checker_model: model,
      research_enabled: config.workflowDefaults.research,
      plan_checker_enabled: config.workflowDefaults.plan_check,
      nyquist_validation_enabled: config.workflowDefaults.nyquist_validation,
      commit_docs: config.commit_docs,
      text_mode: config.workflowDefaults.text_mode,
      auto_advance: config.workflowDefaults.auto_advance,
      auto_chain_active: config.workflowDefaults.auto_chain_active,
      tdd_mode: config.workflowDefaults.tdd_mode,
      phase_found: phaseFound,
      phase_dir: phaseDir,
      phase_number: phaseFound ? (phaseDirMatch.normalized || normalizePhaseNumber(roadmapPhase?.phase_number || requestedPhase)) : null,
      phase_name: phaseDirMatch.phaseName || roadmapPhase?.phase_name || null,
      phase_slug: phaseDirMatch.phaseSlug || roadmapPhase?.phase_slug || null,
      padded_phase: phaseFound ? (phaseDirMatch.normalized || normalizePhaseNumber(roadmapPhase?.phase_number || requestedPhase)) : null,
      phase_req_ids: roadmapPhase?.phase_req_ids || null,
      has_research: artifacts.has_research,
      has_context: artifacts.has_context,
      has_reviews: artifacts.has_reviews,
      has_plans: artifacts.has_plans,
      plan_count: artifacts.plan_count,
      planning_exists: exists(path.join(cwd, '.planning'), 'd'),
      roadmap_exists: exists(path.join(cwd, '.planning', 'ROADMAP.md'), 'f'),
      state_path: exists(path.join(cwd, '.planning', 'STATE.md'), 'f') ? '.planning/STATE.md' : null,
      roadmap_path: exists(path.join(cwd, '.planning', 'ROADMAP.md'), 'f') ? '.planning/ROADMAP.md' : null,
      requirements_path: exists(path.join(cwd, '.planning', 'REQUIREMENTS.md'), 'f') ? '.planning/REQUIREMENTS.md' : null,
      context_path: artifacts.context_path,
      research_path: artifacts.research_path,
      verification_path: artifacts.verification_path,
      uat_path: artifacts.uat_path,
      reviews_path: artifacts.reviews_path,
      patterns_path: artifacts.patterns_path,
      task_tool_available: false,
      ...agentStatus,
    };
    if (config.response_language) {
      result.response_language = config.response_language;
    }
    process.stdout.write(JSON.stringify(result));
    break;
  }
  case 'init.execute-phase': {
    const requestedPhase = rest[0] || getStateField('current_phase') || '1';
    const config = readConfig();
    const phaseData = getPhasePlanIndexData(requestedPhase);
    const roadmapPhase = parseRoadmapPhase(requestedPhase);
    const phaseFound = !!phaseData.phase_dir || !!roadmapPhase;
    const phaseNumber = phaseData.phase || normalizePhaseNumber(roadmapPhase?.phase_number || requestedPhase);
    const phaseName = phaseData.phase_name || roadmapPhase?.phase_name || '';
    const phaseSlug = phaseData.phase_slug || roadmapPhase?.phase_slug || slugify(phaseName);
    const branchingStrategy = getConfigValue('git.branching_strategy', 'none') || 'none';
    const result = {
      executor_model: 'claude-sonnet-4-6',
      verifier_model: 'claude-sonnet-4-6',
      commit_docs: config.commit_docs,
      sub_repos: Array.isArray(config.sub_repos) ? config.sub_repos : [],
      parallelization: config.parallelization !== false,
      context_window: config.context_window,
      branching_strategy: branchingStrategy,
      branch_name: computeBranchName(config, branchingStrategy, phaseNumber, phaseSlug),
      verifier_enabled: getConfigFlag('workflow.verifier', true),
      tdd_mode: config.workflowDefaults.tdd_mode,
      phase_found: phaseFound,
      phase_dir: phaseData.phase_dir || (roadmapPhase ? path.join('.planning', 'phases', phaseNumber + '-' + (roadmapPhase.phase_slug || slugify(phaseName))) : null),
      phase_number: phaseNumber,
      phase_name: phaseName || null,
      phase_slug: phaseSlug || null,
      phase_req_ids: roadmapPhase?.phase_req_ids || null,
      plans: phaseData.plan_files || [],
      summaries: phaseData.summary_files || [],
      incomplete_plans: phaseData.incomplete_plan_files || [],
      plan_count: (phaseData.plan_files || []).length,
      incomplete_count: (phaseData.incomplete_plan_files || []).length,
      state_exists: exists(path.join(cwd, '.planning', 'STATE.md'), 'f'),
      roadmap_exists: exists(path.join(cwd, '.planning', 'ROADMAP.md'), 'f'),
      config_exists: exists(path.join(cwd, '.planning', 'config.json'), 'f'),
      state_path: exists(path.join(cwd, '.planning', 'STATE.md'), 'f') ? '.planning/STATE.md' : null,
      roadmap_path: exists(path.join(cwd, '.planning', 'ROADMAP.md'), 'f') ? '.planning/ROADMAP.md' : null,
      config_path: exists(path.join(cwd, '.planning', 'config.json'), 'f') ? '.planning/config.json' : null,
      task_tool_available: false,
      ...getInstalledAgentStatus(['gsd-executor', 'gsd-verifier']),
    };
    if (config.response_language) {
      result.response_language = config.response_language;
    }
    process.stdout.write(JSON.stringify(result));
    break;
  }
  case 'phase-plan-index': {
    process.stdout.write(JSON.stringify(getPhasePlanIndexData(rest[0] || '')));
    break;
  }
  case 'subagent-executions': {
    const runs = filterSubagentExecutionRuns(rest);
    process.stdout.write(JSON.stringify({
      total: runs.length,
      running: runs.filter((run) => run.status === 'running').length,
      completed: runs.filter((run) => run.status === 'completed').length,
      failed: runs.filter((run) => run.status === 'failed').length,
      abandoned: runs.filter((run) => run.status === 'abandoned').length,
      runs,
    }));
    break;
  }
  case 'state.begin-phase': {
    const phaseIndex = rest.indexOf('--phase');
    const nameIndex = rest.indexOf('--name');
    const plansIndex = rest.indexOf('--plans');
    const phaseValue = phaseIndex >= 0 ? rest[phaseIndex + 1] : (rest[0] || '');
    const nameValue = nameIndex >= 0 ? rest[nameIndex + 1] : '';
    const plansValue = plansIndex >= 0 ? rest[plansIndex + 1] : '';
    updateStateForExecution(phaseValue, nameValue, plansValue);
    process.stdout.write(JSON.stringify({
      phase: phaseValue,
      phase_name: nameValue,
      total_plans_in_phase: plansValue,
      current_step: 'execute',
      updated: true,
    }));
    break;
  }
  case 'find-phase': {
    const phaseInfo = findPhaseDirectory(rest[0] || '');
    const roadmapPhase = phaseInfo.found ? null : parseRoadmapPhase(rest[0] || '');
    process.stdout.write(JSON.stringify({
      found: phaseInfo.found || !!roadmapPhase,
      directory: phaseInfo.found
        ? phaseInfo.phaseDir
        : roadmapPhase
          ? path.join('.planning', 'phases', normalizePhaseNumber(roadmapPhase.phase_number) + '-' + roadmapPhase.phase_slug)
          : null,
      phase_number: phaseInfo.normalized || (roadmapPhase ? normalizePhaseNumber(roadmapPhase.phase_number) : ''),
      phase_name: phaseInfo.phaseName || roadmapPhase?.phase_name || '',
      phase_slug: phaseInfo.phaseSlug || roadmapPhase?.phase_slug || '',
    }));
    break;
  }
  case 'resolve-model': {
    process.stdout.write(rest.includes('--raw') ? 'claude-sonnet-4-6' : JSON.stringify({ model: 'claude-sonnet-4-6' }));
    break;
  }
  case 'commit': {
    const msg = rest[0] || 'chore: gsd update';
    const files = [];
    for (let i = 1; i < rest.length; i++) {
      if (rest[i] === '--files') continue;
      files.push(rest[i]);
    }
    try {
      if (files.length > 0) execSync('git add -- ' + files.map(f => JSON.stringify(f)).join(' '), { cwd, stdio: 'pipe' });
      execSync('git commit -m ' + JSON.stringify(msg), { cwd, stdio: 'pipe' });
    } catch { /* nothing to commit */ }
    break;
  }
  case 'config-new-project': {
    const dir = path.join(cwd, '.planning');
    if (!exists(dir, 'd')) fs.mkdirSync(dir, { recursive: true });
    try { fs.writeFileSync(path.join(dir, 'config.json'), rest[0] || '{}', 'utf8'); } catch { }
    break;
  }
  case 'config-set': {
    const cfgPath = path.join(cwd, '.planning', 'config.json');
    try {
      if (!exists(path.join(cwd, '.planning'), 'd')) fs.mkdirSync(path.join(cwd, '.planning'), { recursive: true });
      const cfg = exists(cfgPath, 'f') ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
      const keys = (rest[0] || '').split('.');
      let obj = cfg;
      for (let i = 0; i < keys.length - 1; i++) { if (!obj[keys[i]]) obj[keys[i]] = {}; obj = obj[keys[i]]; }
      const v = rest[1]; obj[keys[keys.length - 1]] = v === 'true' ? true : v === 'false' ? false : v;
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
    } catch { }
    break;
  }
  case 'config-get': {
    const key = rest[0] || '';
    const raw = rest.includes('--raw');
    const defaultIndex = rest.indexOf('--default');
    const defaultValue = defaultIndex >= 0 ? parseDefaultValue(rest[defaultIndex + 1]) : undefined;
    const value = getConfigValue(key, defaultValue);
    process.stdout.write(raw ? formatScalar(value) : formatScalar(value));
    break;
  }
  case 'roadmap.update-plan-progress': {
    const phaseIdx = rest.indexOf('--phase');
    const phaseValue = phaseIdx >= 0 ? rest[phaseIdx + 1] : (rest.find((arg) => !String(arg).startsWith('--')) || '');
    process.stdout.write(JSON.stringify(updateRoadmapPlanProgress(phaseValue)));
    break;
  }
  case 'generate-claude-md': {
    let out = 'CLAUDE.md';
    for (let i = 0; i < rest.length; i++) { if (rest[i] === '--output' && rest[i+1]) { out = rest[i+1]; i++; } }
    if (!exists(path.join(cwd, out), 'f')) {
      fs.writeFileSync(path.join(cwd, out), '# Project Guide\\n\\nGSD workflow active. Use /gsd-next to advance.\\n\\nSee \`.planning/\` for project state.\\n', 'utf8');
    }
    break;
  }
  case 'roadmap.get-phase': {
    const phase = rest[0] || '1';
    const pickIndex = rest.indexOf('--pick');
    const pick = pickIndex >= 0 ? rest[pickIndex + 1] : '';
    const roadmapPhase = parseRoadmapPhase(phase);
    if (!roadmapPhase) {
      process.stdout.write(pick === 'section' ? '' : JSON.stringify({ found: false, phase_number: phase, phase_name: null, goal: null, section: null }));
      break;
    }
    if (pick === 'section') {
      process.stdout.write(roadmapPhase.section || '');
      break;
    }
    process.stdout.write(JSON.stringify({
      found: true,
      phase_number: roadmapPhase.phase_number,
      phase_name: roadmapPhase.phase_name,
      goal: roadmapPhase.goal,
      section: roadmapPhase.section,
    }));
    break;
  }
  case 'check': {
    if (rest[0] === 'auto-mode') {
      const config = readConfig();
      const pickIndex = rest.indexOf('--pick');
      const pick = pickIndex >= 0 ? rest[pickIndex + 1] : '';
      const payload = {
        auto_chain_active: config.workflowDefaults.auto_chain_active,
        auto_advance: config.workflowDefaults.auto_advance,
      };
      process.stdout.write(pick ? formatScalar(payload[pick]) : JSON.stringify(payload));
      break;
    }
    process.stdout.write('');
    break;
  }
  case 'state.planned-phase': {
    const phaseIndex = rest.indexOf('--phase');
    const nameIndex = rest.indexOf('--name');
    const plansIndex = rest.indexOf('--plans');
    const phaseValue = phaseIndex >= 0 ? rest[phaseIndex + 1] : '';
    const nameValue = nameIndex >= 0 ? rest[nameIndex + 1] : '';
    const plansValue = plansIndex >= 0 ? rest[plansIndex + 1] : '';
    const statePath = path.join(cwd, '.planning', 'STATE.md');
    let content = exists(statePath, 'f') ? fs.readFileSync(statePath, 'utf8') : '';
    const upsertLine = (source, key, value) => {
      const line = key + ': ' + value;
      return new RegExp('^' + key.replace(/[.*+?^$(){}|[\\]\\\\]/g, '\\\\$&') + ':.*$', 'm').test(source)
        ? source.replace(new RegExp('^' + key.replace(/[.*+?^$(){}|[\\]\\\\]/g, '\\\\$&') + ':.*$', 'm'), line)
        : (source.trimEnd() + (source.trim() ? '\\n' : '') + line + '\\n');
    };
    content = upsertLine(content, 'current_phase', phaseValue);
    content = upsertLine(content, 'current_phase_name', nameValue);
    content = upsertLine(content, 'current_step', 'execute');
    content = upsertLine(content, 'total_plans_in_phase', plansValue);
    content = upsertLine(content, 'last_activity', new Date().toISOString());
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, content, 'utf8');
    break;
  }
  case 'verify.key-links': {
    const planFilePath = rest[0];
    if (!planFilePath) {
      process.stdout.write(JSON.stringify({ error: 'plan file path required' }));
      break;
    }
    try {
      const fullPath = resolveProjectPath(planFilePath);
      const content = fs.readFileSync(fullPath, 'utf8');
      const keyLinks = extractKeyLinks(content);
      if (keyLinks.length === 0) {
        process.stdout.write(JSON.stringify({ error: 'No must_haves.key_links found in frontmatter', path: planFilePath }));
        break;
      }
      const links = keyLinks.map((link) => {
        let sourceContent = '';
        let targetContent = '';
        try { sourceContent = link.from ? fs.readFileSync(resolveProjectPath(link.from), 'utf8') : ''; } catch {}
        try { targetContent = link.to ? fs.readFileSync(resolveProjectPath(link.to), 'utf8') : ''; } catch {}
        let verified = false;
        let detail = '';
        if (!sourceContent) {
          detail = 'Source file not found';
        } else if (link.pattern) {
          let regex = null;
          try { regex = new RegExp(link.pattern); } catch { regex = new RegExp(link.pattern.replace(/[.*+?^$(){}|[\\]\\\\]/g, '\\\\$&')); }
          if (regex.test(sourceContent)) {
            verified = true;
            detail = 'Pattern found in source';
          } else if (targetContent && regex.test(targetContent)) {
            verified = true;
            detail = 'Pattern found in target';
          } else {
            detail = 'Pattern not found in source or target';
          }
        } else if (link.to && sourceContent.includes(link.to)) {
          verified = true;
          detail = 'Target referenced in source';
        } else {
          detail = 'Target not referenced in source';
        }
        return {
          from: link.from || '',
          to: link.to || '',
          via: link.via || '',
          verified,
          detail,
        };
      });
      const verifiedCount = links.filter((link) => link.verified).length;
      process.stdout.write(JSON.stringify({
        all_verified: verifiedCount === links.length,
        verified: verifiedCount,
        total: links.length,
        links,
      }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ error: String(error && error.message ? error.message : error), path: planFilePath }));
    }
    break;
  }
  case 'verify.schema-drift': {
    const phaseValue = rest[0] || '';
    const phaseData = getPhasePlanIndexData(phaseValue);
    const schemaFiles = [];
    for (const plan of phaseData.plans || []) {
      for (const filePath of Array.isArray(plan.files_modified) ? plan.files_modified : []) {
        if (/(schema|migration|prisma|drizzle|sql)/i.test(String(filePath))) {
          schemaFiles.push(String(filePath));
        }
      }
    }
    process.stdout.write(JSON.stringify({
      drift_detected: false,
      blocking: false,
      schema_files: Array.from(new Set(schemaFiles)),
      orms: [],
      unpushed_orms: [],
      skipped: true,
      message: phaseData.phase_dir ? 'Schema drift check skipped by Tasktronaut shim.' : 'Phase directory not found',
    }));
    break;
  }
  case 'phase.complete': {
    const phaseValue = rest[0] || '';
    if (!phaseValue) {
      process.stdout.write(JSON.stringify({ error: 'phase number required for phase complete' }));
      break;
    }
    const phaseData = getPhasePlanIndexData(phaseValue);
    const phaseInfo = findPhaseDirectory(phaseValue);
    const phaseNumber = phaseData.phase || normalizePhaseNumber(phaseValue);
    const planCount = (phaseData.plan_files || []).length;
    const summaryCount = (phaseData.summary_files || []).length;
    const today = new Date().toISOString().split('T')[0];
    const warnings = [];
    if (phaseData.phase_dir) {
      const phaseAbs = path.join(cwd, phaseData.phase_dir);
      for (const file of fs.readdirSync(phaseAbs).filter((name) => name.includes('-UAT') && name.endsWith('.md'))) {
        const content = fs.readFileSync(path.join(phaseAbs, file), 'utf8');
        if (/result:\\s*pending/i.test(content)) warnings.push(file + ': has pending tests');
        if (/result:\\s*blocked/i.test(content)) warnings.push(file + ': has blocked tests');
        if (/status:\\s*partial/i.test(content)) warnings.push(file + ': testing incomplete (partial)');
      }
      for (const file of fs.readdirSync(phaseAbs).filter((name) => name.includes('-VERIFICATION') && name.endsWith('.md'))) {
        const content = fs.readFileSync(path.join(phaseAbs, file), 'utf8');
        if (/status:\\s*human_needed/i.test(content)) warnings.push(file + ': needs human verification');
        if (/status:\\s*gaps_found/i.test(content)) warnings.push(file + ': has unresolved gaps');
      }
    }
    const roadmapUpdate = updateRoadmapPlanProgress(phaseValue);
    if (roadmapUpdate.updated) {
      const roadmapPath = path.join(cwd, '.planning', 'ROADMAP.md');
      let roadmapContent = fs.readFileSync(roadmapPath, 'utf8');
      const phaseEscaped = phaseNumber.replace(/[.*+?^$(){}|[\\]\\\\]/g, '\\\\$&');
      const checkboxPattern = new RegExp('(-\\\\s*\\\\[)[ ](\\\\]\\\\s*.*Phase\\\\s+' + phaseEscaped + '[:\\\\s][^\\\\n]*)', 'i');
      roadmapContent = roadmapContent.replace(checkboxPattern, '$1x$2 (completed ' + today + ')');
      fs.writeFileSync(roadmapPath, roadmapContent, 'utf8');
    }
    const requirementsPath = path.join(cwd, '.planning', 'REQUIREMENTS.md');
    let requirementsUpdated = false;
    if (exists(requirementsPath, 'f')) {
      const requirementIds = readPhaseRequirementIds(phaseValue);
      if (requirementIds.length > 0) {
        let requirementsContent = fs.readFileSync(requirementsPath, 'utf8');
        for (const requirementId of requirementIds) {
          const reqEscaped = requirementId.replace(/[.*+?^$(){}|[\\]\\\\]/g, '\\\\$&');
          requirementsContent = requirementsContent.replace(new RegExp('(-\\\\s*\\\\[)[ ](\\\\]\\\\s*\\\\*\\\\*' + reqEscaped + '\\\\*\\\\*)', 'gi'), '$1x$2');
          requirementsContent = requirementsContent.replace(new RegExp('(\\\\|\\\\s*' + reqEscaped + '\\\\s*\\\\|[^|]+\\\\|)\\\\s*(?:Pending|In Progress)\\\\s*(\\\\|)', 'gi'), '$1 Complete $2');
        }
        fs.writeFileSync(requirementsPath, requirementsContent, 'utf8');
        requirementsUpdated = true;
      }
    }
    const nextPhase = findNextPhaseInfo(phaseNumber);
    const statePath = path.join(cwd, '.planning', 'STATE.md');
    let stateUpdated = false;
    if (exists(statePath, 'f')) {
      let stateContent = fs.readFileSync(statePath, 'utf8');
      stateContent = upsertLine(stateContent, 'current_phase', nextPhase ? nextPhase.phase : phaseNumber);
      stateContent = upsertLine(stateContent, 'current_phase_name', nextPhase ? nextPhase.name : (phaseInfo?.phaseName || ''));
      stateContent = upsertLine(stateContent, 'current_step', nextPhase ? 'plan' : 'complete');
      stateContent = upsertLine(stateContent, 'last_activity', new Date().toISOString());
      fs.writeFileSync(statePath, stateContent, 'utf8');
      stateUpdated = true;
    }
    process.stdout.write(JSON.stringify({
      completed_phase: phaseNumber,
      phase_name: phaseInfo?.phaseName || null,
      plans_executed: summaryCount + '/' + planCount,
      next_phase: nextPhase ? nextPhase.phase : null,
      next_phase_name: nextPhase ? nextPhase.name : null,
      is_last_phase: !nextPhase,
      date: today,
      roadmap_updated: roadmapUpdate.updated === true,
      state_updated: stateUpdated,
      requirements_updated: requirementsUpdated,
      warnings,
      has_warnings: warnings.length > 0,
    }));
    break;
  }
  case 'learnings.copy': {
    process.stdout.write(JSON.stringify({
      copied: false,
      skipped: true,
      message: 'Global learnings copy is not implemented in the Tasktronaut shim yet.',
    }));
    break;
  }
  case 'roadmap.annotate-dependencies': {
    break;
  }
  case 'check.decision-coverage-plan': {
    process.stdout.write(JSON.stringify({
      data: {
        passed: true,
        skipped: true,
        total: 0,
        covered: 0,
        uncovered: [],
        message: 'Decision coverage gate skipped by Tasktronaut shim.',
      },
    }));
    break;
  }
  case 'agent-skills':
  case 'state.record-session':
  case 'todo.match-phase':
  default:
    process.stdout.write('');
    break;
}
`

const GSD_TOOLS_WRAPPER = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const command = args[0];
const cwd = process.cwd();
const graphPath = path.join(cwd, '.planning', 'graphs', 'graph.json');

function print(value) {
  process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

function collectStringMatches(value, query, location, results, budget) {
  if (results.length >= budget) return;
  if (typeof value === 'string') {
    if (value.toLowerCase().includes(query)) {
      results.push({ path: location || '$', value: value.slice(0, 300) });
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length && results.length < budget; index++) {
      collectStringMatches(value[index], query, location + '[' + index + ']', results, budget);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (results.length >= budget) break;
      const nextLocation = location ? location + '.' + key : key;
      collectStringMatches(child, query, nextLocation, results, budget);
    }
  }
}

if (command === 'graphify' && args[1] === 'status') {
  if (!fs.existsSync(graphPath)) {
    print({ exists: false, stale: true, age_hours: null });
    process.exit(0);
  }
  const ageMs = Date.now() - fs.statSync(graphPath).mtimeMs;
  const ageHours = Number((ageMs / (1000 * 60 * 60)).toFixed(1));
  print({ exists: true, stale: ageHours > 24, age_hours: ageHours, path: '.planning/graphs/graph.json' });
  process.exit(0);
}

if (command === 'graphify' && args[1] === 'query') {
  if (!fs.existsSync(graphPath)) {
    print({ query: args[2] || '', results: [], note: 'graph.json not found' });
    process.exit(0);
  }

  const query = String(args[2] || '').toLowerCase();
  const budgetIndex = args.indexOf('--budget');
  const budget = budgetIndex >= 0 ? Math.max(1, Number(args[budgetIndex + 1] || 5)) : 5;
  const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
  const results = [];
  collectStringMatches(graph, query, '$', results, Math.min(budget, 10));
  print({ query: args[2] || '', results });
  process.exit(0);
}

if (command === 'gap-analysis') {
  const phaseDirIndex = args.indexOf('--phase-dir');
  const phaseDir = phaseDirIndex >= 0 ? args[phaseDirIndex + 1] : '';
  if (!phaseDir) {
    print('## Post-Planning Gap Analysis\\n\\nNo phase directory provided.');
    process.exit(0);
  }
  print(
    '## Post-Planning Gap Analysis\\n\\n' +
    'Tasktronaut shim does not yet compute the full deterministic gap table. ' +
    'Review ' + phaseDir + '/*-PLAN.md, .planning/REQUIREMENTS.md, and ' + phaseDir + '/CONTEXT.md manually if you need a full audit.'
  );
  process.exit(0);
}

print({ error: 'Unsupported command', args });
`

function buildPowerShellNodeBridge(nodePath: string, jsFileName: string): string {
	const escapedNodePath = nodePath.replace(/'/g, "''")
	const escapedJsFileName = jsFileName.replace(/'/g, "''")

	return [
		`$ErrorActionPreference = 'Stop'`,
		`$scriptPath = Join-Path -Path $PSScriptRoot -ChildPath '${escapedJsFileName}'`,
		`$inputData = [Console]::In.ReadToEnd()`,
		`$inputData | & '${escapedNodePath}' $scriptPath @args`,
		`if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }`,
		`exit 0`,
	].join("\n")
}

function buildCmdNodeBridge(nodePath: string, jsFileName: string): string {
	return [`@echo off`, `set SCRIPT_DIR=%~dp0`, `"${nodePath}" "%SCRIPT_DIR%${jsFileName}" %*`].join("\r\n") + "\r\n"
}

function buildShellNodeBridge(nodePath: string, jsFileName: string): string {
	const escapedNodePath = nodePath.replace(/'/g, `'\\''`)
	const escapedJsFileName = jsFileName.replace(/'/g, `'\\''`)

	return [
		`#!/bin/sh`,
		`SCRIPT_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"`,
		`exec '${escapedNodePath}' "$SCRIPT_DIR/${escapedJsFileName}" "$@"`,
	].join("\n") + "\n"
}

async function writeWorkspaceHookScript(hooksDir: string, hookName: string, scriptContent: string): Promise<void> {
	const hookPath = path.join(hooksDir, hookName)

	if (process.platform === "win32") {
		const jsPath = `${hookPath}.js`
		const ps1Path = `${hookPath}.ps1`

		await writeFile(jsPath, scriptContent, "utf8")
		await writeFile(ps1Path, buildPowerShellNodeBridge(process.execPath, path.basename(jsPath)), "utf8")
		return
	}

	await writeFile(hookPath, scriptContent, "utf8")
	await chmod(hookPath, 0o755)
}

async function writeWorkspaceCliScript(binDir: string, commandName: string, scriptContent: string): Promise<void> {
	const jsFileName = `${commandName}.js`
	const jsPath = path.join(binDir, jsFileName)
	await writeFile(jsPath, scriptContent, "utf8")

	if (process.platform === "win32") {
		await writeFile(path.join(binDir, `${commandName}.cmd`), buildCmdNodeBridge(process.execPath, jsFileName), "utf8")
		return
	}

	const launcherPath = path.join(binDir, commandName)
	await writeFile(launcherPath, buildShellNodeBridge(process.execPath, jsFileName), "utf8")
	await chmod(launcherPath, 0o755)
}

const TASKTRONAUTRULES_TEMPLATE = `# GSD (Get Shit Done) Workflow v1.5
# Bundled with this extension. No external downloads required.

## gsd-sdk

gsd-sdk is bundled at \`.tasktronaut/bin/gsd-sdk\` (or \`.cmd\` on Windows).
Tasktronaut adds \`.tasktronaut/bin\` to terminal PATH for workspace tasks, so
\`gsd-sdk query ...\` should work without a separate global install.
If a shell cannot resolve \`gsd-sdk\`, run it explicitly as:
  .tasktronaut/bin/gsd-sdk query ...

## Runtime Constraints

The Task subagent spawning tool is NOT available in this runtime.
Use Tasktronaut's named subagent tools instead when available:
- \`use_subagent_gsd_codebase_mapper\`
- \`use_subagent_gsd_executor\`
- \`use_subagent_gsd_pattern_mapper\`
- \`use_subagent_gsd_planner\`
- \`use_subagent_gsd_plan_checker\`
- \`use_subagent_gsd_ui_researcher\`
- \`use_subagent_gsd_ui_checker\`
- \`use_subagent_gsd_security_auditor\`
- \`use_subagent_gsd_nyquist_auditor\`
- \`use_subagent_gsd_project_researcher\`
- \`use_subagent_gsd_research_synthesizer\`
- \`use_subagent_gsd_roadmapper\`
- \`use_subagent_gsd_phase_researcher\`
- \`use_subagent_gsd_verifier\`

When a workflow still calls generic \`Task(prompt="...", subagent_type="...")\`,
do NOT assume it works. Prefer the matching named Tasktronaut subagent tool
above. If no named tool is available, execute the step inline in the current
context window.

gsd-sdk continues to return \`task_tool_available: false\` because the generic
Claude-style Task API is not present, even though Tasktronaut-native named
subagent tools may be installed under \`.tasktronaut/agents\`.


## Overview
GSD is a spec-driven workflow for AI-assisted development.
It prevents context rot by using fresh context windows per execution phase.
State lives in .planning/ at the workspace root.

## Directory Convention
- .planning/PROJECT.md   — vision, goals, constraints
- .planning/ROADMAP.md   — phased delivery plan
- .planning/STATE.md     — current phase / step
- .planning/PLANS/       — XML task plans per phase
- .planning/SUMMARIES/   — phase completion summaries

## Slash Commands
When the user runs a /gsd-* command, execute the matching workflow below.
Do not apply GSD workflows unless the user explicitly invokes a /gsd-* command.

### /gsd-new-project
1. Ask discovery questions: goals, constraints, tech stack, timeline.
2. Write .planning/PROJECT.md with vision and constraints.
3. Write .planning/ROADMAP.md with 3-7 phases.
4. Write .planning/STATE.md: current_phase: 1, current_step: discuss.

### /gsd-discuss-phase
1. Read STATE.md for current phase.
2. Ask questions: approach, risks, acceptance criteria, dependencies.
3. Write decisions to .planning/PLANS/phase-N-decisions.md.
4. Update STATE.md: current_step: plan.

### /gsd-plan-phase
1. Read STATE.md, PROJECT.md, ROADMAP.md, and phase decisions.
2. Scan relevant source directories.
3. Write .planning/PLANS/phase-N.xml with tasks: id, description, files_affected, acceptance_criteria.
4. Update STATE.md: current_step: execute.

### /gsd-execute-phase
1. Read STATE.md and phase-N.xml plan.
2. Group independent tasks into waves; execute each wave.
3. Commit after each task: git commit -m "task(N.M): description".
4. Update STATE.md: current_step: verify on completion.

### /gsd-verify-work
1. Read acceptance criteria from phase-N.xml.
2. Verify each criterion is met.
3. On pass: write .planning/SUMMARIES/phase-N.md, advance STATE.md to next phase.
4. On fail: write fix plan and re-enter execute.

### /gsd-next
Read STATE.md and run the appropriate next /gsd-* command automatically.

### /gsd-quick
Run a single task outside the phase workflow. Commit as: quick: description.

## Rules
- Never skip discuss — decisions made here prevent rework.
- Plans are immutable once execution starts.
- One commit per task, no bundling.
- Verify against original acceptance criteria, not the implementation.
- On context pressure (>150k tokens), save STATE.md and open a fresh task.
`

export async function installGsdToWorkspace(workspacePath: string): Promise<void> {
	const clinerulesDir = path.join(workspacePath, ".tasktronautrules")
	const hooksDir = path.join(clinerulesDir, "hooks")

	try {
		// Create .tasktronautrules/ and .tasktronautrules/hooks/ if needed
		await mkdir(hooksDir, { recursive: true })

		// Write the GSD rules file (only if not already present, to avoid overwriting user edits)
		const gsdRulesPath = path.join(clinerulesDir, "gsd.md")
		if (!existsSync(gsdRulesPath)) {
			await writeFile(gsdRulesPath, TASKTRONAUTRULES_TEMPLATE, "utf8")
			Logger.info("[GSD] Wrote .tasktronautrules/gsd.md")
		}

		// Write hook scripts and make them executable
		const hooks: Array<[string, string]> = [
			["PreCompact", HOOK_PRE_COMPACT],
			["TaskStart", HOOK_TASK_START],
			["UserPromptSubmit", HOOK_USER_PROMPT_SUBMIT],
			["PostToolUse", HOOK_POST_TOOL_USE],
			["gsd-sdk", GSD_SDK_SHIM],
		]

		for (const [name, content] of hooks) {
			await writeWorkspaceHookScript(hooksDir, name, content)
		}

		Logger.info("[GSD] Installed GSD v1.5 hooks to .tasktronautrules/hooks/")

		const tasktronautDir = path.join(workspacePath, ".tasktronaut")
		const agentsDir = path.join(tasktronautDir, "agents")
		const binDir = path.join(tasktronautDir, "bin")

		// Install Tasktronaut-native agents and supporting research assets to .tasktronaut/
		await mkdir(agentsDir, { recursive: true })
		await mkdir(binDir, { recursive: true })
		for (const agent of GSD_AGENTS) {
			const agentPath = path.join(agentsDir, `${agent.name}.md`)
			if (!existsSync(agentPath)) {
				await writeFile(agentPath, agent.content, "utf8")
			}
		}
		for (const asset of GSD_RESEARCH_ASSETS) {
			const assetPath = path.join(tasktronautDir, asset.targetPath)
			await mkdir(path.dirname(assetPath), { recursive: true })
			if (!existsSync(assetPath)) {
				await writeFile(assetPath, asset.content, "utf8")
			}
		}
		const gsdToolsWrapperPath = path.join(binDir, "gsd-tools.cjs")
		await writeFile(gsdToolsWrapperPath, GSD_TOOLS_WRAPPER, "utf8")
		if (process.platform !== "win32") {
			await chmod(gsdToolsWrapperPath, 0o755)
		}
		await writeWorkspaceCliScript(binDir, "gsd-tools", GSD_TOOLS_WRAPPER)
		await writeWorkspaceCliScript(binDir, "gsd-sdk", GSD_SDK_SHIM)
		Logger.info("[GSD] Installed Tasktronaut agents and research assets to .tasktronaut/")
	} catch (error) {
		Logger.warn(`[GSD] Failed to install GSD clinerules: ${error instanceof Error ? error.message : String(error)}`)
	}
}
