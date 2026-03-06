import { readFile } from 'node:fs/promises';

const OPERATORS = {
  eq: (a, b) => a === b,
  neq: (a, b) => a !== b,
  gt: (a, b) => Number(a) > Number(b),
  gte: (a, b) => Number(a) >= Number(b),
  lt: (a, b) => Number(a) < Number(b),
  lte: (a, b) => Number(a) <= Number(b),
  in: (a, b) => Array.isArray(b) && b.includes(a),
  not_in: (a, b) => Array.isArray(b) && !b.includes(a),
  exists: (a) => a !== undefined && a !== null,
  not_exists: (a) => a === undefined || a === null
};

function getValue(obj, path) {
  if (!path || typeof path !== 'string') return undefined;
  const parts = path.split('.');
  let cur = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

function stripYamlComments(text) {
  return text
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('#');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

function parseScalar(value) {
  const trimmed = String(value ?? '').trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((p) => parseScalar(p.trim()));
  }
  return trimmed;
}

// Lightweight YAML subset parser that supports this structure:
// defaults.action, rules[].{name,when,then,reason,params}
function parseSimpleYamlPolicy(input) {
  const text = stripYamlComments(input);
  const lines = text.split('\n');

  const out = { defaults: {}, rules: [] };
  let section = null;
  let currentRule = null;
  let inWhen = false;
  let inParams = false;
  let nestedKey = null;

  for (const raw of lines) {
    if (!raw.trim()) continue;
    const indent = raw.match(/^\s*/)?.[0]?.length ?? 0;
    const line = raw.trim();

    if (line === 'defaults:') {
      section = 'defaults';
      continue;
    }
    if (line === 'rules:') {
      section = 'rules';
      continue;
    }

    if (section === 'defaults') {
      const [k, ...rest] = line.split(':');
      if (!k || rest.length === 0) continue;
      out.defaults[k.trim()] = parseScalar(rest.join(':'));
      continue;
    }

    if (section === 'rules') {
      if (line.startsWith('- name:')) {
        if (currentRule) out.rules.push(currentRule);
        currentRule = { name: parseScalar(line.slice('- name:'.length)), when: {}, then: 'deny', reason: '', params: {} };
        inWhen = false;
        inParams = false;
        nestedKey = null;
        continue;
      }
      if (!currentRule) continue;

      if (line === 'when:') {
        inWhen = true;
        inParams = false;
        nestedKey = null;
        continue;
      }
      if (line === 'params:') {
        inParams = true;
        inWhen = false;
        nestedKey = null;
        continue;
      }
      if (line.startsWith('then:')) {
        currentRule.then = parseScalar(line.slice('then:'.length));
        inWhen = false;
        inParams = false;
        nestedKey = null;
        continue;
      }
      if (line.startsWith('reason:')) {
        currentRule.reason = parseScalar(line.slice('reason:'.length));
        continue;
      }

      if (inWhen) {
        const [k, ...rest] = line.split(':');
        if (!k) continue;
        const rhs = rest.join(':').trim();

        if (rhs === '') {
          // nested operator block e.g. max_spend:\n  gt: 5
          nestedKey = k.trim();
          currentRule.when[nestedKey] = currentRule.when[nestedKey] ?? {};
          continue;
        }

        if (nestedKey && indent >= 8 && OPERATORS[k.trim()]) {
          currentRule.when[nestedKey][k.trim()] = parseScalar(rhs);
          continue;
        }

        nestedKey = null;
        currentRule.when[k.trim()] = parseScalar(rhs);
        continue;
      }

      if (inParams) {
        const [k, ...rest] = line.split(':');
        if (!k || rest.length === 0) continue;
        currentRule.params[k.trim()] = parseScalar(rest.join(':'));
      }
    }
  }

  if (currentRule) out.rules.push(currentRule);
  return out;
}

export class PolicyEngine {
  constructor(policyConfig = {}) {
    this.defaults = policyConfig.defaults ?? { action: 'deny' };
    this.rules = Array.isArray(policyConfig.rules) ? policyConfig.rules : [];
  }

  static fromObject(policyConfig) {
    return new PolicyEngine(policyConfig);
  }

  static async fromFile(path) {
    const raw = await readFile(path, 'utf8');
    const trimmed = raw.trim();
    let parsed;
    if (trimmed.startsWith('{')) {
      parsed = JSON.parse(trimmed);
    } else {
      parsed = parseSimpleYamlPolicy(trimmed);
    }
    return new PolicyEngine(parsed);
  }

  evaluate(request = {}) {
    const matchedRules = [];

    for (const rule of this.rules) {
      const conditions = rule?.when ?? {};
      let ok = true;

      for (const [field, constraint] of Object.entries(conditions)) {
        const actual = getValue(request, field);

        if (constraint && typeof constraint === 'object' && !Array.isArray(constraint)) {
          for (const [operator, expected] of Object.entries(constraint)) {
            const fn = OPERATORS[operator];
            if (!fn || !fn(actual, expected)) {
              ok = false;
              break;
            }
          }
        } else if (actual !== constraint) {
          ok = false;
        }

        if (!ok) break;
      }

      if (ok) {
        matchedRules.push(rule.name ?? 'unnamed_rule');
        const action = rule.then ?? 'deny';
        return {
          allowed: action === 'allow' || action === 'throttle',
          action,
          matchedRules,
          reason: rule.reason || `Matched rule: ${rule.name ?? 'unnamed_rule'}`,
          params: rule.params ?? {}
        };
      }
    }

    const defaultAction = this.defaults?.action ?? 'deny';
    return {
      allowed: defaultAction === 'allow',
      action: defaultAction,
      matchedRules,
      reason: 'No matching policy rule',
      params: {}
    };
  }

  static checkCompatibility(policyA, policyB) {
    const a = policyA instanceof PolicyEngine ? policyA : new PolicyEngine(policyA);
    const b = policyB instanceof PolicyEngine ? policyB : new PolicyEngine(policyB);

    const conflicts = [];
    const warnings = [];

    if ((a.defaults?.action ?? 'deny') === 'deny' && (b.defaults?.action ?? 'deny') === 'deny') {
      warnings.push('Both policies default to deny; explicit allow intersections are required.');
    }

    const aRules = new Map((a.rules ?? []).map((r) => [JSON.stringify(r?.when ?? {}), r]));
    for (const r of b.rules ?? []) {
      const key = JSON.stringify(r?.when ?? {});
      const ar = aRules.get(key);
      if (ar && (ar.then ?? 'deny') !== (r.then ?? 'deny')) {
        conflicts.push({
          condition: r.when ?? {},
          actionA: ar.then ?? 'deny',
          actionB: r.then ?? 'deny',
          ruleA: ar.name ?? null,
          ruleB: r.name ?? null
        });
      }
    }

    return {
      compatible: conflicts.length === 0,
      conflicts,
      warnings
    };
  }
}

export function createDefaultPolicy() {
  return {
    version: '1',
    defaults: { action: 'deny' },
    rules: []
  };
}
