export type DebateMode = 'off' | 'shadow' | 'on';
export type AdvocateRole = 'sound' | 'fragile' | 'reviewer';

export interface DebateInput {
  facts_text: string;
  level: string;
  points: number;
  flag_ids: string[];
  unknown: string[];
}

export interface RouteArgs {
  task_type: 'risk_debate';
  tier_class: 'text';
  complexity: 'exec' | 'apex';
  context_tokens: number;
  constitutional_flag: false;
  agent_id: 'golden-kog';
  payload: {
    role: AdvocateRole;
    system: string;
    prompt: string;
    max_tokens: number;
  };
}

export interface RouteResult {
  content: string;
  model?: string;
  cost_usd?: number;
}

export interface DebateDeps {
  route(args: RouteArgs): Promise<RouteResult>;
  check?(text: string): string[];
  mode?: DebateMode;
  log?(row: object): void;
  timeoutMs?: number;
}

export interface Debate {
  status: 'ok' | 'rejected' | 'timeout' | 'off';
  shown: boolean;
  sound: string;
  fragile: string;
  reviewer: string;
  weight: string[];
  unknown: string[];
  tension?: string;
  models: { sound?: string; fragile?: string; reviewer?: string };
  usd: number;
  rejected: string[];
}

const SAFE_FALLBACK = 'No case could be written from the measured facts.';
const FORBIDDEN = [
  /\bbull\b/i, /\bbear\b/i, /\bbullish\b/i, /\bbearish\b/i,
  /\bupside\b/i, /\bdownside\s+target\b/i, /\bundervalued\b/i,
  /\bovervalued\b/i, /\baccumulate\b/i, /\bmoon\b/i,
  /\bbuy\s+now\b/i, /\bsell\s+now\b/i, /\bprice\s+target\b/i,
  /\bentry\b/i, /\bexit\b/i, /\btake\s+profit\b/i,
  /\bnot\s+financial\s+advice\b/i,
];
const LONG_DASHES = /[-\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/;
const NON_LATIN_DIGIT = /[^\x00-\x7F\d]/u;
const NUMBER_TOKEN = /(?:\d+(?:\.\d+)?|\.\d+)/g;

function numericTokens(text: string): string[] {
  return text.match(NUMBER_TOKEN) ?? [];
}

function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/u).length : 0;
}

function validatePart(text: string, facts: string, maxWords: number, deps: DebateDeps): string[] {
  const problems: string[] = [];
  const knownNumbers = new Set(numericTokens(facts));
  const unknownNumbers = numericTokens(text).filter(n => !knownNumbers.has(n));
  if (unknownNumbers.length) problems.push(`number not in facts_text: ${[...new Set(unknownNumbers)].join(', ')}`);
  if (FORBIDDEN.some(pattern => pattern.test(text))) problems.push('contains refused trading language');
  if (LONG_DASHES.test(text)) problems.push('contains a dash character');
  // Non-ASCII digits are rejected explicitly. Other Unicode punctuation is allowed except dashes.
  if ([...text].some(c => /\p{Nd}/u.test(c) && !/[0-9]/.test(c))) problems.push('contains a non-Latin digit');
  if (wordCount(text) > maxWords) problems.push(`word limit exceeded: ${wordCount(text)} > ${maxWords}`);
  try {
    const external = deps.check?.(text) ?? [];
    if (external.length) problems.push(...external.map(x => `caller guard: ${x}`));
  } catch (error) {
    problems.push(`caller guard failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return problems;
}

function costOf(result: RouteResult): number {
  const cost = result.cost_usd ?? 0;
  return Number.isFinite(cost) && cost >= 0 ? cost : 0;
}

function textForRole(role: 'sound' | 'fragile', input: DebateInput): string {
  const direction = role === 'sound'
    ? 'Present the strongest cautious case that the measured structure has resilient properties.'
    : 'Present the strongest cautious case that the measured structure has fragility or unresolved risk.';
  return [
    `Role: ${role}. ${direction}`,
    'Use only the supplied measured facts. Cite no fact or number that is not present in facts_text.',
    'Do not make a trading recommendation, forecast, valuation, or suggestion to transact.',
    `Level: ${input.level}`,
    `Points: ${input.points}`,
    `Flag IDs: ${JSON.stringify(input.flag_ids)}`,
    `Unknowns already recorded: ${JSON.stringify(input.unknown)}`,
    'Return concise plain text under the specified word limit. Do not use dash characters.',
    'Measured facts:', input.facts_text,
  ].join('\n');
}

function request(role: AdvocateRole, input: DebateInput, sound = '', fragile = ''): RouteArgs {
  const reviewer = role === 'reviewer';
  const prompt = reviewer
    ? [
        'Review both arguments against measured facts only. Do not issue a trading view or change level or points.',
        `Level: ${input.level}`,
        `Points: ${input.points}`,
        `Allowed flag IDs: ${JSON.stringify(input.flag_ids)}`,
        `Recorded unknowns: ${JSON.stringify(input.unknown)}`,
        'Measured facts:', input.facts_text,
        'Sound case:', sound,
        'Fragile case:', fragile,
        'Return only JSON with string text, array weight, array unknown and optional string tension. Every fact and number must be grounded in facts_text. No dash characters or refused trading language.',
      ].join('\n')
    : textForRole(role, input);
  return {
    task_type: 'risk_debate',
    tier_class: 'text',
    complexity: reviewer ? 'apex' : 'exec',
    context_tokens: Math.max(512, Math.ceil((input.facts_text.length + sound.length + fragile.length + 1400) / 3)),
    constitutional_flag: false,
    agent_id: 'golden-kog',
    payload: {
      role,
      system: reviewer
        ? 'You are a cautious structure risk reviewer. This is risk analysis, never a trading tool. Return valid JSON only.'
        : 'You are a cautious structure risk advocate. This is risk analysis, never a trading tool. Use only supplied measured facts.',
      prompt,
      max_tokens: reviewer ? 650 : 480,
    },
  };
}

function rejected(input: DebateInput, reasons: string[], usd = 0, models: Debate['models'] = {}): Debate {
  return {
    status: 'rejected', shown: false, sound: '', fragile: '', reviewer: '',
    weight: [], unknown: [...input.unknown], models, usd, rejected: reasons,
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('risk debate call timed out')), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function debate(input: DebateInput, deps: DebateDeps): Promise<Debate> {
  const mode = deps.mode ?? 'shadow';
  const timeoutMs = deps.timeoutMs ?? 45_000;
  if (mode === 'off') {
    return { status: 'off', shown: false, sound: '', fragile: '', reviewer: '', weight: [], unknown: [...input.unknown], models: {}, usd: 0, rejected: [] };
  }
  if (!input.facts_text.trim() || !Array.isArray(input.flag_ids) || !Array.isArray(input.unknown) || !Number.isFinite(input.points)) {
    return rejected(input, ['invalid input shape']);
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) return rejected(input, ['invalid timeoutMs']);

  let soundResult: RouteResult;
  let fragileResult: RouteResult;
  try {
    [soundResult, fragileResult] = await Promise.all([
      withTimeout(deps.route(request('sound', input)), timeoutMs),
      withTimeout(deps.route(request('fragile', input)), timeoutMs),
    ]);
  } catch (error) {
    const reason = error instanceof Error && error.message.includes('timed out')
      ? 'advocate call timed out'
      : `advocate call failed: ${error instanceof Error ? error.message : String(error)}`;
    return { status: reason.includes('timed out') ? 'timeout' : 'rejected', shown: false, sound: '', fragile: '', reviewer: '', weight: [], unknown: [...input.unknown], models: {}, usd: 0, rejected: [reason] };
  }
  const usdAdvocates = costOf(soundResult) + costOf(fragileResult);
  const models: Debate['models'] = {};
  if (soundResult.model) models.sound = soundResult.model;
  if (fragileResult.model) models.fragile = fragileResult.model;
  const reasons: string[] = [];

  const soundProblems = validatePart(soundResult.content, input.facts_text, 180, deps);
  let sound = soundResult.content;
  if (soundProblems.length) {
    sound = SAFE_FALLBACK;
    reasons.push(...soundProblems.map(x => `sound: ${x}`));
  }
  const fragileProblems = validatePart(fragileResult.content, input.facts_text, 180, deps);
  let fragile = fragileResult.content;
  if (fragileProblems.length) {
    fragile = SAFE_FALLBACK;
    reasons.push(...fragileProblems.map(x => `fragile: ${x}`));
  }

  let reviewerResult: RouteResult;
  try {
    reviewerResult = await withTimeout(deps.route(request('reviewer', input, sound, fragile)), timeoutMs);
  } catch (error) {
    const reason = error instanceof Error && error.message.includes('timed out') ? 'reviewer call timed out' : `reviewer call failed: ${error instanceof Error ? error.message : String(error)}`;
    return { status: reason.includes('timed out') ? 'timeout' : 'rejected', shown: false, sound: '', fragile: '', reviewer: '', weight: [], unknown: [...input.unknown], models, usd: usdAdvocates, rejected: [...reasons, reason] };
  }
  const usd = usdAdvocates + costOf(reviewerResult);
  if (reviewerResult.model) models.reviewer = reviewerResult.model;

  let parsed: { text?: unknown; weight?: unknown; unknown?: unknown; tension?: unknown };
  try {
    parsed = JSON.parse(reviewerResult.content);
  } catch {
    return rejected(input, [...reasons, 'reviewer: unparseable JSON'], usd, models);
  }
  if (typeof parsed.text !== 'string' || !Array.isArray(parsed.weight) || !parsed.weight.every(x => typeof x === 'string') || !Array.isArray(parsed.unknown) || !parsed.unknown.every(x => typeof x === 'string') || (parsed.tension !== undefined && typeof parsed.tension !== 'string')) {
    return rejected(input, [...reasons, 'reviewer: invalid JSON schema'], usd, models);
  }
  const reviewerText = [parsed.text, ...parsed.unknown, ...(parsed.tension === undefined ? [] : [parsed.tension])].join('\n');
  const reviewerProblems = validatePart(reviewerText, input.facts_text, 150, deps);
  if (reviewerProblems.length) return rejected(input, [...reasons, ...reviewerProblems.map(x => `reviewer: ${x}`)], usd, models);
  const allowedFlags = new Set(input.flag_ids);
  const weight = parsed.weight.filter(id => allowedFlags.has(id));
  const unknown = parsed.unknown as string[];
  const result: Debate = {
    status: 'ok', shown: mode === 'on', sound, fragile, reviewer: parsed.text,
    weight, unknown, models, usd, rejected: reasons,
  };
  if (parsed.tension !== undefined) result.tension = parsed.tension as string;
  if (mode === 'shadow') {
    try { deps.log?.(result); } catch { /* Logging must not change the risk decision. */ }
  }
  return result;
}
