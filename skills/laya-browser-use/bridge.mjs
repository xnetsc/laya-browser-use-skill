import { localDecision, warmLocalDecision } from './laya-local.mjs';
import { modelManifest } from './prepare-model.mjs';

export async function loadConfig() {
  const status = await warmLocalDecision();
  return {
    provider: 'laya-local', model: status.model, backend: status.backend,
    runtimeBrowser: status.runtimeBrowser, platform: status.platform,
  };
}

const LOCAL_PROVIDER = 'laya-local';
const LOCAL_MODEL = modelManifest().model;
const instructions = 'Choose the single next candidate action that best advances the goal using the current browser accessibility state and action history. Do not repeat an action already reflected in the current state.';
const clickRoles = new Set(['button','link','checkBox','checkbox','check box','radio button','radioButton','menu item','menuItem','tab','switch','toggle button','togglebutton','menu button']);
const supportedKeys = new Set(['Enter','Escape','Tab','Shift+Tab','PageUp','PageDown','Home','End']);

export function parseState(state) {
  return state.split('\n').map(line => line.trim()).map(line => line.match(/^(\d+) (text field|text area|combo box|radio button|menu item|menu button|toggle button|check box|switch|[\w]+)(?: \([^)]*\))? (?:Description: )?(.*)$/)).filter(Boolean).map(match => ({index:Number(match[1]),role:match[2],name:match[3]}));
}

function controlNames(control) {
  return [control.name,...(control.aliases ?? [])].filter(name => typeof name === 'string' && name);
}

function matchesName(observed, expected) {
  return observed === expected || observed?.startsWith(`${expected}, Value:`);
}

function semanticName(name) {
  return name.replace(/, Value:.*$/, '');
}

function matchesPattern(name, pattern) {
  if (pattern instanceof RegExp) {
    pattern.lastIndex = 0;
    return pattern.test(name);
  }
  return typeof pattern === 'string' && matchesName(name,pattern);
}

export function checkState(snapshot, allowedOrigins) {
  const url = snapshot.match(/^Browser tab:.* URL: "([^"]+)"\./m)?.[1];
  let origin;
  try { origin = new URL(url).origin; } catch { throw new Error('Cannot verify browser origin'); }
  if (!allowedOrigins.includes(origin)) throw new Error('Browser left the configured origins');
  if (snapshot.length > 24000) throw new Error('Snapshot too large; narrow the task');
}

export function validateControl(control) {
  if (!control || typeof control !== 'object') return false;
  if (control.op === 'click') return typeof control.name === 'string' && !!control.name;
  if (control.op === 'scroll') return ['up','down'].includes(control.direction) && Number.isInteger(control.amount ?? 1) && (control.amount ?? 1) >= 1 && (control.amount ?? 1) <= 5 && (!control.targetName || typeof control.targetName === 'string') && (!control.point || (Array.isArray(control.point) && control.point.length === 2 && control.point.every(Number.isFinite))) && !(control.targetName && control.point);
  if (control.op === 'press') return supportedKeys.has(control.key);
  return control.op === 'reload';
}

function description(control) {
  if (control.description) return control.description;
  if (control.op === 'scroll') return `Scroll ${control.direction}${(control.amount ?? 1) > 1 ? ` ${control.amount} pages` : ''}${control.targetName ? ` within ${control.targetName}` : control.point ? ' within the host-identified region' : ''}`;
  if (control.op === 'press') return `Press ${control.key}`;
  if (control.op === 'reload') return 'Reload the current page';
  return `Click ${control.name}`;
}

export async function decide({provider=LOCAL_PROVIDER,model=LOCAL_MODEL,goal,state,actions,history=[]}) {
  if (provider !== LOCAL_PROVIDER) throw new Error('Unsupported decision provider');
  if (model !== LOCAL_MODEL) throw new Error('Unsupported local decision model');
  const entries = actions.map((action,index) => [`a${index}`,action.description]);
  if (!entries.length) throw new Error('No candidate browser action is available');
  const criteria = Object.fromEntries(entries);
  // This checkpoint has a visible option-position bias. Score the same choice in both orders in
  // one multi-question call and average by stable label. The model/runtime can share work across
  // the pair, and no action is taken from either unbalanced answer on its own.
  const question = (ordered) => ({type:'choice',instructions,criteria:Object.fromEntries(ordered)});
  const questions = {forward:question(entries),reverse:question([...entries].reverse())};
  const startedAt = performance.now();
  const result = await localDecision({state:{goal,browser:state,history},questions});
  if (result.model !== LOCAL_MODEL) throw new Error('Invalid local Laya decision model');
  const labels = Object.keys(criteria).sort();
  const rows = Object.values(result.answers ?? {});
  if (rows.length !== 2) throw new Error('Invalid local Laya decision schema');
  for (const answer of rows) {
    const probabilities = answer?.probabilities;
    if (answer?.type !== 'choice' || !probabilities || Object.keys(probabilities).sort().join('|') !== labels.join('|') || Object.values(probabilities).some(value => !Number.isFinite(value) || value < 0 || value > 1) || Math.abs(Object.values(probabilities).reduce((a,b) => a+b,0)-1) > 0.02) throw new Error('Invalid local Laya decision schema');
  }
  const probabilities = Object.fromEntries(labels.map(label => [label,
    rows.reduce((sum,answer) => sum + answer.probabilities[label], 0) / rows.length]));
  const choice = labels.reduce((best,label) => probabilities[label] > probabilities[best] ? label : best, labels[0]);
  const ranked = Object.values(probabilities).sort((a,b) => b-a);
  // Keep the original 0.55 handoff boundary meaningful when the candidate count changes: use
  // the winner's share of the top-two mass rather than demanding an impossible 55% of every
  // five-, ten-, or twenty-way distribution.
  const confidence = ranked[0] / Math.max(Number.EPSILON, ranked[0] + (ranked[1] ?? 0));
  return {provider,choice,confidence,probabilities,model:result.model,apiMs:Math.round(performance.now()-startedAt),action:choice.startsWith('a') ? actions[Number(choice.slice(1))] : null};
}

export function availableActions(state, controls=[]) {
  const entries = parseState(state);
  const actions = [];
  for (const control of controls) {
    if (!validateControl(control)) throw new Error('Unsupported action');
    if (control.op === 'scroll') {
      const names = [control.targetName,...(control.targetAliases ?? [])].filter(Boolean);
      const matches = names.length ? entries.filter(entry => names.some(name => matchesName(entry.name,name))) : [];
      if (names.length && matches.length !== 1) continue;
      actions.push({...control,target:control.point ?? matches[0]?.index,amount:control.amount ?? 1,description:description(control)});
      continue;
    }
    if (['press','reload'].includes(control.op)) {
      actions.push({...control,description:description(control)});
      continue;
    }
    const names = controlNames(control);
    const matches = entries.filter(entry => clickRoles.has(entry.role) && names.some(name => matchesName(entry.name,name)));
    if (matches.length !== 1) continue;
    actions.push({...control,index:matches[0].index,description:description(control)});
  }
  return actions;
}

// The host defines the candidate set before constructing this policy. Text fields are never
// auto-discovered because the adapter does not enter text.
export function discoverActions(state, policy={}) {
  const entries = parseState(state);
  const denied = policy.denyNames ?? [];
  const requiresHost = policy.requireHostNames ?? [];
  const allowed = policy.allowNames ?? [];
  const counts = new Map();
  for (const entry of entries) counts.set(semanticName(entry.name),(counts.get(semanticName(entry.name)) ?? 0)+1);
  const actions = [];
  if (policy.click === true) {
    for (const entry of entries) {
      if (!clickRoles.has(entry.role) || counts.get(semanticName(entry.name)) !== 1) continue;
      if (denied.some(pattern => matchesPattern(entry.name,pattern)) || requiresHost.some(pattern => matchesPattern(entry.name,pattern))) continue;
      if (allowed.length && !allowed.some(pattern => matchesPattern(entry.name,pattern))) continue;
      actions.push({op:'click',name:entry.name,index:entry.index,description:`Click ${entry.name}`});
    }
  }
  const scrollAmount = Number.isInteger(policy.scrollAmount) && policy.scrollAmount >= 1 && policy.scrollAmount <= 5 ? policy.scrollAmount : 1;
  const scrollNames = [policy.scrollTargetName,...(policy.scrollTargetAliases ?? [])].filter(Boolean);
  const scrollMatches = scrollNames.length ? entries.filter(entry => scrollNames.some(name => matchesName(entry.name,name))) : [];
  const validPoint = Array.isArray(policy.scrollPoint) && policy.scrollPoint.length === 2 && policy.scrollPoint.every(Number.isFinite);
  const scrollTarget = validPoint ? policy.scrollPoint : scrollMatches.length === 1 ? scrollMatches[0].index : undefined;
  const canScroll = !scrollNames.length || scrollMatches.length === 1;
  for (const direction of policy.scrollDirections ?? []) if (['up','down'].includes(direction) && canScroll) actions.push({op:'scroll',direction,amount:scrollAmount,target:scrollTarget,description:`Scroll ${direction}${scrollAmount > 1 ? ` ${scrollAmount} pages` : ''}${scrollNames.length ? ` within ${policy.scrollTargetName}` : validPoint ? ' within the host-identified region' : ''}`});
  for (const key of policy.keys ?? []) if (supportedKeys.has(key)) actions.push({op:'press',key,description:`Press ${key}`});
  if (policy.reload === true) actions.push({op:'reload',description:'Reload the current page'});
  return actions;
}

async function execute(tab, action) {
  if (action.op === 'click') await tab.click(action.index);
  else if (action.op === 'scroll' && action.target !== undefined) await tab.scroll(action.target,action.direction,action.amount ?? 1);
  else if (action.op === 'scroll') for (let i=0;i<(action.amount ?? 1);i++) await tab.pressKey(null,action.direction === 'down' ? 'PageDown' : 'PageUp');
  else if (action.op === 'press') await tab.pressKey(null,action.key);
  else if (action.op === 'reload') await tab.reload();
}

function handoff(status) {
  return ({low_confidence:'low_confidence',blocked:'model_blocked',no_progress:'no_progress',loading_timeout:'loading_timeout',decision_error:'decision_error',action_error:'action_error',budget:'budget',step_limit:'step_limit'})[status] ?? null;
}

function result(status,history,state,startedAt,details={}) {
  return {status,handoff:handoff(status),history,state,elapsedMs:Math.round(performance.now()-startedAt),...details};
}

// This accepts a host browser adapter; it never opens the target browser.
export async function run(tab,{goal,controls=[],policy,envFile,provider,model,allowedOrigins,maxSteps=10,minConfidence=0.55,maxMs=45000,decisionTimeoutMs=20000,maxDecisionRetries=1,waitPollMs=750},prior=[]) {
  if (typeof goal !== 'string' || !goal || !Array.isArray(controls) || (!controls.length && !policy) || controls.some(control => !validateControl(control)) || !Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 30 || !Number.isFinite(maxMs) || maxMs < 1 || maxMs > 45000 || !Number.isFinite(decisionTimeoutMs) || decisionTimeoutMs < 1000 || decisionTimeoutMs > 30000 || !Number.isInteger(maxDecisionRetries) || maxDecisionRetries < 0 || maxDecisionRetries > 2 || !Number.isFinite(minConfidence) || minConfidence < 0.55 || minConfidence > 1 || !Number.isFinite(waitPollMs) || waitPollMs < 100 || waitPollMs > 5000 || !Array.isArray(allowedOrigins) || !allowedOrigins.length) throw new Error('Invalid task contract');
  const history = [...prior];
  const startedAt = performance.now();
  let waits = 0;
  let decisionRetries = 0;
  let state = await tab.getAXState({emit:false,disableDiffing:true});
  for (let step=0;step<maxSteps;step++) {
    checkState(state,allowedOrigins);
    if (performance.now()-startedAt > maxMs) return result('budget',history,state,startedAt);
    const actions = [...availableActions(state,controls),...discoverActions(state,policy)].filter((action,index,all) => {
      const key = `${action.op}:${action.index ?? ''}:${action.direction ?? ''}:${action.amount ?? ''}:${action.key ?? ''}:${String(action.target ?? '')}`;
      return all.findIndex(candidate => `${candidate.op}:${candidate.index ?? ''}:${candidate.direction ?? ''}:${candidate.amount ?? ''}:${candidate.key ?? ''}:${String(candidate.target ?? '')}` === key) === index;
    });
    // Laya selects among concrete candidate actions. Once no named candidate from the contract is
    // present, the loop returns the fresh state. With no prior progress this is a blocked handoff.
    if (!actions.length) return result(history.some(item => item.executed) ? 'needs_verification' : 'blocked',history,state,startedAt);
    let decision;
    const decisionStartedAt = performance.now();
    try {
      decision = await decide({envFile,provider,model,goal,state,actions,history,timeoutMs:Math.max(1,Math.min(decisionTimeoutMs,Math.floor(maxMs-(performance.now()-startedAt))))});
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Decision failed';
      const canRetry = /transport failure or timeout/.test(message) && decisionRetries < maxDecisionRetries && maxMs-(performance.now()-startedAt) >= 1000;
      history.push({provider:provider ?? LOCAL_PROVIDER,choice:'ERROR',confidence:null,model:model ?? LOCAL_MODEL,apiMs:Math.round(performance.now()-decisionStartedAt),action:'Decision request',executed:false,reason:canRetry ? 'decision_retry' : 'decision_error'});
      if (canRetry) {
        decisionRetries += 1;
        state = await tab.getAXState({emit:false,disableDiffing:true});
        checkState(state,allowedOrigins);
        step -= 1;
        continue;
      }
      return result('decision_error',history,state,startedAt,{error:error instanceof Error ? error.message : 'Decision failed'});
    }
    decisionRetries = 0;
    const record = {provider:decision.provider,choice:decision.choice,confidence:decision.confidence,model:decision.model,apiMs:decision.apiMs,action:decision.action?.description ?? decision.choice};
    const fresh = await tab.getAXState({emit:false,disableDiffing:true});
    checkState(fresh,allowedOrigins);
    if (performance.now()-startedAt >= maxMs) return result('budget',history,fresh,startedAt);
    if (fresh !== state) { history.push({...record,executed:false,reason:'stale_state'}); state=fresh; continue; }
    if (decision.confidence < minConfidence) return result('low_confidence',[...history,record],state,startedAt);
    if (decision.choice === 'WAIT') {
      history.push({...record,executed:false,reason:'wait'});
      if (++waits >= 3) return result('loading_timeout',history,state,startedAt);
      const remaining = maxMs-(performance.now()-startedAt);
      if (remaining <= 0) return result('budget',history,state,startedAt);
      await new Promise(resolve => setTimeout(resolve,Math.min(waitPollMs,remaining)));
      state = await tab.getAXState({emit:false,disableDiffing:true});
      continue;
    }
    waits = 0;
    if (!decision.action) return result(decision.choice === 'DONE' ? 'needs_verification' : 'blocked',[...history,record],state,startedAt);
    if (history.at(-1)?.noEffect && history.at(-1).action === record.action) return result('no_progress',history,state,startedAt);
    try {
      await execute(tab,decision.action);
    } catch (error) {
      history.push({...record,executed:false,reason:'action_error'});
      return result('action_error',history,state,startedAt,{error:error instanceof Error ? error.message : 'Action failed'});
    }
    history.push({...record,executed:true});
    const next = await tab.getAXState({emit:false,disableDiffing:true});
    checkState(next,allowedOrigins);
    if (next === state) {
      if (decision.action.op === 'scroll') history[history.length-1].effectNeedsVisualVerification = true;
      else history[history.length-1].noEffect = true;
    }
    state = next;
  }
  return result('step_limit',history,state,startedAt);
}

export function createSession(tab,defaults={}) {
  let history = [];
  let elapsedMs = 0;
  let runs = 0;
  let handoffs = {};
  const metrics = () => ({runs,decisions:history.length,executedActions:history.filter(item => item.executed).length,decisionRetries:history.filter(item => item.reason === 'decision_retry').length,failedDecisions:history.filter(item => item.reason === 'decision_error').length,apiMs:history.reduce((total,item) => total+(item.apiMs ?? 0),0),elapsedMs,handoffs:{...handoffs}});
  return {
    async run(task) {
      const outcome = await run(tab,{...defaults,...task},history);
      history = outcome.history;
      elapsedMs += outcome.elapsedMs;
      runs += 1;
      if (outcome.handoff) handoffs[outcome.handoff] = (handoffs[outcome.handoff] ?? 0)+1;
      return {...outcome,sessionMetrics:metrics()};
    },
    metrics,
    history:() => [...history],
    reset() { history=[]; elapsedMs=0; runs=0; handoffs={}; }
  };
}

export async function waitForState(tab,{allowedOrigins,includes=[],excludes=[],timeoutMs=45000,pollMs=1000}) {
  if (!Array.isArray(allowedOrigins) || !allowedOrigins.length || !Array.isArray(includes) || !Array.isArray(excludes) || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 || !Number.isFinite(pollMs) || pollMs < 100 || pollMs > 5000) throw new Error('Invalid wait contract');
  const startedAt = performance.now();
  let state = '';
  while (performance.now()-startedAt < timeoutMs) {
    state = await tab.getAXState({emit:false,disableDiffing:true});
    checkState(state,allowedOrigins);
    if (includes.every(value => state.includes(value)) && excludes.every(value => !state.includes(value))) return {status:'matched',state,elapsedMs:Math.round(performance.now()-startedAt)};
    const remaining = timeoutMs-(performance.now()-startedAt);
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve,Math.min(pollMs,remaining)));
  }
  return {status:'timeout',state,elapsedMs:Math.round(performance.now()-startedAt)};
}
