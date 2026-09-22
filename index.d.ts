// Type definitions for notjev — hand written, no build step.
/// <reference types="node" />

export type Band = 'low' | 'med' | 'high' | 'certain';

/** An option: a bare code, or a code plus what the menu shows for it. A `description` CHANGES the
 *  prompt (therefore the measurement); `text` replaces the rendered line entirely. */
export type OptionSpec = string | number | {
	id?: string | number;
	code?: string | number;
	value?: string | number;
	description?: string;
	text?: string;
};

/** The three closed forms. Exactly one of them per question. */
export interface QuestionForm {
	options?: OptionSpec[];
	/** `true` uses the literals `true`/`false`; a pair puts the caller's own two options in the menu. */
	noul?: true | { yes: OptionSpec; no: OptionSpec };
	/** `n` means the scale `1..n`; `{min,max}` is explicit. The grades are read as DIGITS. */
	score?: number | { min?: number; max: number };
}

export interface Question extends QuestionForm {
	id?: string | number;
	/** The context block. Not trimmed: a trailing newline is part of the measured layout. */
	state?: string | null;
	/** The question line — the NAME of what is being asked. */
	question?: string;
	/** Overrides the frozen format instruction. Vary one thing at a time, and print the prompt. */
	instruction?: string;
	system?: string;
	theta?: number;
	edges?: number[];
	maxTokens?: number;
	topLogprobs?: number;
	model?: string;
	/** Cancels the in-flight HTTP decision. */
	signal?: AbortSignal;
	/** `null`/`false` removes `chat_template_kwargs` from the body (OpenAI); an object replaces it. */
	templateKwargs?: Record<string, unknown> | null | false;
	/** Merged into the request body, last. */
	extra?: Record<string, unknown>;
}

export interface Decision {
	/** `false` when NO option mass was seen: the model answered outside the codomain. */
	ok: boolean;
	/** The chosen code, or `null` when the margin abstains. Never a fallback. */
	choice: string | null;
	index: number;
	/** What the model would have said without the margin — readable, never applied. */
	top: string;
	/** The re-typed answer: the code, a boolean (`noul`), an integer (`score`), or `null`. */
	value: string | boolean | number | null;
	/** Only for `score`: the expectation over the whole distribution. */
	expectation?: number | null;
	p1: number;
	p2: number;
	margin: number;
	band: Band;
	/** The MIDDLE of the band — what is portable between engines, unlike the raw float. */
	prior: number;
	/** The option mass before renormalisation. Low coverage = the model meant something else. */
	coverage: number;
	exactMass: number;
	spacedMass: number;
	degraded: boolean;
	undecided: boolean;
	theta: number;
	kind: 'choice' | 'noul' | 'score';
	options: string[];
	letters: string[];
	/** Sums to 1 over the options. Aligned with `options`/`letters`. */
	probabilities: number[];
	byOption: Record<string, number>;
	mass: number[];
	entries: { token: string; logprob: number; prob: number }[];
	/** The EXACT string that was sent. Read it before theorising about the model. */
	prompt: string | null;
	request: Record<string, unknown> | null;
	/** The server response, as parsed. */
	raw: unknown;
	/** The distribution as a compact JSON string — what belongs in a log, instead of one letter. */
	readoutRaw: string | null;
	ms: number | null;
	usage: unknown;
	model: string | null;
	id?: string | number;
	question?: string;
	explain(): string;
}

export interface ClientOptions {
	baseUrl?: string;
	model?: string;
	apiKey?: string;
	theta?: number;
	edges?: number[];
	topLogprobs?: number;
	maxTokens?: number;
	instruction?: string;
	system?: string;
	templateKwargs?: Record<string, unknown> | null | false;
	extra?: Record<string, unknown>;
	headers?: Record<string, string>;
	timeoutMs?: number;
	retries?: number;
	retryDelayMs?: number;
	concurrency?: number;
	path?: string;
	fetch?: typeof fetch;
	env?: NodeJS.ProcessEnv;
}

export interface Client {
	baseUrl: string;
	model?: string;
	theta: number;
	path: string;
	decide(q: Question): Promise<Decision>;
	noul(state: string | null, question: string, pair?: { yes: OptionSpec; no: OptionSpec } | true,
		more?: Partial<Question>): Promise<Decision>;
	score(state: string | null, question: string, range?: number | { min?: number; max: number },
		more?: Partial<Question>): Promise<Decision>;
	decideMany(state: string | null, questions: Question[],
		opts?: { concurrency?: number; onError?: 'throw' | 'collect';
			onResult?: (r: Decision, i: number, n: number) => void }): Promise<Decision[]>;
	/** The exact string, without sending anything. */
	prompt(q: Question): string;
	/** The exact body, without sending anything. */
	body(q: Question): { params: Record<string, unknown>; content: string; form: unknown };
	models(): Promise<unknown>;
	readResponse: typeof readResponse;
}

export function createClient(options?: ClientOptions): Client;

/** The PURE reading: a recorded response, a question form, a theta -> the same Decision. */
export function readResponse(resp: unknown, spec: QuestionForm & {
	theta?: number; edges?: number[]; prompt?: string; request?: unknown; ms?: number; model?: string;
}): Decision;

export interface ReplayRow {
	id: string | number;
	family?: string;
	choice: string | null;
	top: string;
	value: string | boolean | number | null;
	p1: number; p2: number; margin: number;
	band: Band; prior: number;
	coverage: number; spaced: number;
	degraded: boolean; undecided: boolean; theta: number;
	expected?: string; correct?: boolean;
	ms: number | null;
}

export function replay(record: { results: unknown[] } | unknown[], opts?: {
	theta?: number; edges?: number[]; truth?: string; options?: OptionSpec[];
}): { rows: ReplayRow[]; meta: Record<string, unknown> };

export function report(rows: ReplayRow[], opts?: { bins?: number; thetas?: number[]; positive?: string }): {
	n: number; withTruth: number;
	accuracy: ReturnType<typeof metrics.accuracy>;
	ece: ReturnType<typeof metrics.ece>;
	sweep: ReturnType<typeof metrics.sweep>;
	bands: ReturnType<typeof metrics.byBand>;
	f1: ReturnType<typeof metrics.f1> | null;
	coverage: number; degraded: number; spaced: number;
};

export function createServer(opts?: ClientOptions & { client?: Client; bodyLimit?: number;
	apiKey?: string; log?: ((...a: unknown[]) => void) | null }): import('http').Server;

/** JSON-compatible OpenAI chat messages; content parts can include image_url for HTTP engines. */
export interface ContextMessage {
	role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
	content: string | null | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
	tool_call_id?: string;
	tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
	[key: string]: unknown;
}
export type ContextInput = {
	type?: 'fresh' | 'messages'; state?: string | null; messages?: ContextMessage[];
	model?: string; tools?: Record<string, unknown>[];
	templateKwargs?: Record<string, unknown> | null | false;
};
export type ContextSelector = ContextInput | { type: 'snapshot'; ref: string };
/** `current` works only when a NotJev gateway binds the model's tool call to its request. */
export type GatewayContextSelector = ContextSelector | { type: 'current' };
export interface ContextQuestion extends Pick<Question, 'question' | 'options' | 'noul' | 'score' | 'theta' | 'instruction'> {
	id?: string;
}
export interface CompactDecision {
	id: string;
	status: 'decided' | 'undecided' | 'degraded' | 'error';
	choice?: string | null; value?: string | boolean | number | null;
	margin?: number; p1?: number; coverage?: number;
	degraded?: boolean; undecided?: boolean; expectation?: number | null;
	model?: string | null; ms?: number | null; usage?: unknown;
	cache?: { status: 'unknown' | 'reported'; cachedTokens?: number; checkpoint?: boolean };
	error?: { code: string; message: string };
}
export interface ContextBackend {
	model?: string;
	decideContext(input: { context: ContextInput; question: ContextQuestion; signal?: AbortSignal }): Promise<Decision>;
	validateContext?(context: ContextInput): void;
	close?(): Promise<void>;
}
export interface DecisionService {
	store: ContextStore;
	putContext(context: ContextInput, options?: { scope?: string }): { ref: string; expiresAt: number; bytes: number };
	dropContext(ref: string, options?: { scope?: string }): { dropped: true };
	decide(input: { context?: ContextSelector; questions: ContextQuestion[]; execution?: 'independent' },
		options?: { scope?: string; signal?: AbortSignal }): Promise<{ contextRef: string | null; model: string | null; results: CompactDecision[] }>;
	close(): Promise<void>;
}
export interface ContextStore {
	put(context: ContextInput, scope?: string): { ref: string; expiresAt: number; bytes: number };
	acquire(ref: string, scope?: string): { data: ContextInput; release(): void };
	drop(ref: string, scope?: string): { dropped: true };
	stats(): { entries: number; bytes: number };
	clear(): void;
}
export function createContextStore(options?: { maxEntries?: number; maxBytes?: number; ttlMs?: number;
	clock?: () => number }): ContextStore;
export function createDecisionService(options?: ClientOptions & { backend?: ContextBackend; store?: ContextStore;
	storeOptions?: { maxEntries?: number; maxBytes?: number; ttlMs?: number };
	maxQuestions?: number; maxContextBytes?: number; concurrency?: number; timeoutMs?: number;
	ownsBackend?: boolean }): DecisionService;
export function createHttpContextBackend(options?: ClientOptions & { client?: Client }): ContextBackend;
export function createNativeContextBackend(options: { modelPath: string; model?: string;
	gpu?: false | 'auto' | 'cuda' | 'vulkan'; requireGpu?: boolean; contextSize?: number;
	chunkSize?: number; mmproj?: string; theta?: number }): Promise<ContextBackend & { info: Record<string, unknown> }>;
export function createGateway(options: { service: DecisionService; baseUrl?: string;
	apiKey?: string; upstreamApiKey?: string; scope?: string; toolName?: string;
	bodyLimit?: number; timeoutMs?: number; fetch?: typeof fetch }): import('http').Server;
export function createRemoteService(options: { baseUrl: string; apiKey?: string; fetch?: typeof fetch }):
	Pick<DecisionService, 'decide' | 'putContext' | 'dropContext' | 'close'>;
export function createMcpServer(options: { service: DecisionService; scope?: string }): Promise<{
	connect(transport: unknown): Promise<void>; close(): Promise<void> }>;

/* ── THE JEV WIRE CONTRACT (POST /v1/systemone) ─────────────────────────────────────────── */

/** One question of a `/v1/systemone` request. `criteria` depends on `type`: noul — optional
 *  `{true, false}` descriptions; choice — `{ name: description }`; score — `[level0, level1, …]`. */
export interface WireQuestion {
	type: 'noul' | 'choice' | 'score';
	instructions: string;
	criteria?: unknown;
}

/** The `notjev` block on every wire answer — the instrument fields the contract has no room for. */
export interface WireExtension {
	p1: number; p2: number; margin: number; band: Band; prior: number;
	coverage: number; exactMass: number; spacedMass: number;
	degraded: boolean; undecided: boolean; theta: number; top: string;
}

export interface WireAnswers {
	nouls: Record<string, { type: 'noul'; noul: number; confidence: number; notjev: WireExtension }>;
	choices: Record<string, { type: 'choice'; choice: string | null;
		probabilities: Record<string, number>; confidence: number; notjev: WireExtension }>;
	scores: Record<string, { type: 'score'; score: number | null; legend: string[];
		probabilities: Record<string, number>; confidence: number; notjev: WireExtension }>;
}

export namespace wire {
	/** The wire request -> the library's questions. Throws `NOTJEV_WIRE_422` with a FastAPI
	 *  `.detail` list — refused BEFORE the engine is spent. */
	function toQuestions(body: { model?: string; state: string; theta?: number;
		questions: Record<string, WireQuestion> }): {
		state: string; theta: number; questions: Question[];
		specs: { name: string; type: 'noul' | 'choice' | 'score'; criteria: unknown; ids: string[] }[] };
	/** The decideMany rows -> the grouped answers. Throws `NOTJEV_WIRE_UPSTREAM` when any
	 *  question failed — every name answered or none, never a half-filled response. */
	function toAnswers(specs: { name: string; type: 'noul' | 'choice' | 'score';
		criteria: unknown; ids: string[] }[], results: Decision[]): {
		answers: WireAnswers; usage: { input_tokens: number | null; output_tokens: number | null } };
	/** `1 − H(p)/ln K` over the renormalised distribution — certain = 1, uniform = 0. */
	function confidenceOf(probabilities: number[]): number;
}

export namespace readout {
	const LETTERS: string;
	const MAX_OPTIONS: number;
	const INSTRUCTION: string;
	const QUESTION_TAG: string;
	const CONTEXT_TAG: string;
	const BAND_EDGES: number[];
	const BANDS: Band[];
	const THETA_DEFAULT: number;
	const UNDECIDED: string;
	function codomain(o: { choice?: string[]; noul?: true; score?: number }): {
		options: string[]; kind: 'choice' | 'noul' | 'score'; decode(c: string): string | boolean | number };
	function assertOptions(options: string[], kind: string): void;
	function lettersOf(options: string[]): string[];
	function renderTurn(o: { state?: string | null; question?: string; options: string[]; instruction?: string }): string;
	function chatParams(o: { model?: string; content: string; maxTokens?: number; topLogprobs?: number }): Record<string, unknown>;
	function entriesOf(resp: unknown): { token: string; logprob: number; prob: number }[];
	function distribution(entries: { token: string; logprob: number; prob?: number }[], letters: string[]): {
		probabilities: number[]; mass: number[]; coverage: number;
		exactMass: number; spacedMass: number; degraded: boolean };
	function bandOf(p: number, edges?: number[]): Band;
	function snap(p: number, edges?: number[]): number;
	function decide(o: { probabilities: number[]; options: string[]; theta?: number; edges?: number[] }): {
		choice: string | null; index: number; top: string; p1: number; p2: number; margin: number;
		band: Band; prior: number; undecided: boolean; theta: number };
	function rawOf(resp: unknown): string | null;
	function parseRaw(s: string | null): { token: string; logprob: number; prob: number }[];
	function menuOf(prompt: string): string[];
	function questionTagOf(prompt: string): string | null;
	function logRawFor(prompt: unknown, resp: unknown): string | null;
}

export interface MetricRow {
	p1?: number; margin?: number; band?: Band;
	choice?: string; expected?: string; correct?: boolean;
}

export namespace metrics {
	function isCorrect(r: MetricRow): boolean | null;
	function ece(rows: MetricRow[], bins?: number): {
		ece: number | null; n: number;
		bins: { lo: number; hi: number; n: number; conf: number; acc: number }[] };
	function sweep(rows: MetricRow[], thetas?: number[]): {
		theta: number; decided: number; coverage: number | null; right: number; precision: number | null }[];
	function f1(rows: MetricRow[], positive: string): {
		p: number | null; r: number | null; f1: number | null; tp: number; fp: number; fn: number };
	function nullArm(rows: MetricRow[]): {
		klass: string; n: number; total: number; accuracy: number; counts: Record<string, number> } | null;
	function oracleArm(rows: MetricRow[]): { total: number; accuracy: number | null };
	function accuracy(rows: MetricRow[]): {
		n: number; right: number; accuracy: number | null;
		nullArm: ReturnType<typeof nullArm>; oracle: ReturnType<typeof oracleArm> };
	function byBand(rows: MetricRow[], bands?: string[]): {
		band: string; n: number; p1: number | null; accuracy: number | null }[];
}

export const renderTurn: typeof readout.renderTurn;
export const chatParams: typeof readout.chatParams;
export const entriesOf: typeof readout.entriesOf;
export const distribution: typeof readout.distribution;
export const bandOf: typeof readout.bandOf;
export const snap: typeof readout.snap;
export const INSTRUCTION: string;
export const LETTERS: string;
export const MAX_OPTIONS: number;
export const BANDS: Band[];
export const BAND_EDGES: number[];
export const THETA_DEFAULT: number;
export const UNDECIDED: string;
export function formOf(q: QuestionForm): { kind: string; ids: string[]; texts: string[]; decode(c: string): unknown; values: unknown[] };
export function optionOf(x: OptionSpec): { id: string; text: string };

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * THE MODULES (2026-09-21) — packed, tokenizer checks, calibration, harness, set, contract,
 * backends. Every one of them returns the same shape as the core: `entries` -> `distribution`
 * -> `decide`. Nothing here renormalises silently.
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

/** `[{token, logprob}]` — the one shape every backend produces, per position read. */
export interface Entry { token: string; logprob: number; prob?: number; rank?: number; id?: number }

/** `(text) => token ids` — injected: a server's `/tokenize`, or node-llama-cpp. */
export type Tokenize = (text: string) => Promise<number[]> | number[];

export namespace chatml {
	/** `content: null` = an OPEN turn (the one whose next token is read). */
	function render(turns: { role: string; content?: string | null }[],
		o?: { thinkingOff?: boolean }): string;
}

export interface PackedSpec {
	prompt: string;
	/** The index of the token whose distribution answers question `i`. */
	positions: number[];
	slots: { id: string | number; letters: string[]; options: string[]; form: unknown; question?: string }[];
	nTokens: number;
	placeholder: string;
}

export interface PackedDecision extends Omit<Decision, 'byOption' | 'prompt' | 'request' | 'raw'> {
	id: string | number;
	position: number;
	question?: string;
	topToken: Entry | null;
	backend: string;
}

export namespace packed {
	function buildPacked(o: { state?: string | null; questions: Question[]; tokenize: Tokenize;
		placeholder?: string }): Promise<PackedSpec>;
	function readPacked(resp: unknown, spec: PackedSpec,
		opts?: { theta?: number; edges?: number[] }): PackedDecision[];
	function divergence(a: { id: string | number; top: string; band?: Band }[],
		b: { id: string | number; top: string; band?: Band }[]): {
			n: number; differ: number; rate: number; byBand: Record<string, { n: number; differ: number }> };
	function entriesAt(promptLogprobs: unknown[], pos: number): Entry[] | null;
	function createPackedClient(o: { baseUrl: string; model?: string; tokenize: Tokenize;
		fetch?: typeof fetch; k?: number; theta?: number; edges?: number[]; placeholder?: string }): {
			decidePacked(state: string | null, questions: Question[], opts?: { theta?: number; edges?: number[] }):
				Promise<{ rows: PackedDecision[]; packed: PackedSpec; ms: number; nTokens: number }>;
			buildPacked(state: string | null, questions: Question[]): Promise<PackedSpec>;
		};
}

export namespace tokenizer {
	/** Every letter must be ONE token, with distinct ids — else `LETTER_NOT_ATOMIC`. */
	function checkLetters(tokenize: Tokenize, letters: string[]): Promise<{ ids: number[] }>;
	/** `tok(prompt+letter) === tok(prompt) ++ [id]` — else `ANSWER_BOUNDARY`. */
	function checkBoundary(tokenize: Tokenize, prompt: string, letter: string): Promise<{ id: number }>;
	/** Two codes sharing their first token would merge two options into one mass. */
	function firstTokenCollision(tokenize: Tokenize, codes: string[], opts?: { strict?: boolean }):
		Promise<{ ok: boolean; collisions: [string, string][] }>;
	function makeHttpTokenizer(o: { baseUrl: string; kind?: 'vllm' | 'llama-server';
		model?: string; fetch?: typeof fetch }): (text: string) => Promise<number[]>;
}

export namespace calibration {
	function applyTemperature(probabilities: number[], T: number): number[];
	/** `label` = the INDEX of the right option. A `T` is published WITH its split. */
	function fitTemperature(rows: { probabilities: number[]; label: number }[],
		o?: { grid?: number[]; split?: string }): {
			T: number; nll: number; eceBefore: number | null; eceAfter: number | null; n: number; split: string };
	function nll(rows: { probabilities: number[]; label: number }[], T: number): number;
	function calibrated<D extends { probabilities: number[]; options: string[]; theta?: number }>(
		decision: D, T: number): D & { T: number };
}

export namespace harness {
	function lcg(seed: number): () => number;
	function shuffled(n: number, rnd: () => number): number[];
	/** `order[i]` = the ORIGINAL index of the option now shown at `i`. */
	function permute(question: Question, seed: number): { question: Question; order: number[] };
	function unpermute<D extends { probabilities: number[]; options: string[] }>(decision: D, order: number[]): D;
	function swapAB(state: string, m: { a: string; b: string; end?: string }): string;
	function stratify<R>(rows: R[], by: (r: R) => string, n: number, seed: number): R[];
	function nullArms(rows: { label: string; options?: string[]; candidates?: string[]; state?: string }[]):
		{ majority: number; first: number; lexical: number };
	/** Paired by `id`; `top` is the option CODE — under permutation an index is not an answer. */
	function flips(a: { id: string | number; top: string }[], b: { id: string | number; top: string }[]):
		{ n: number; flips: number; rate: number };
}

export interface SetNode { division: string; node: string; p: number; margin: number; band: Band; prior: number }

export namespace set {
	function readSet(o: { divisions: { id: string; poles: string[]; probabilities: number[]; applies?: number }[];
		theta?: number; minBand?: Band; edges?: number[] }): {
			active: SetNode[]; undecided: SetNode[]; skipped: { division: string; applies: number }[] };
	function setMetrics(predicted: string[], gold: string[]):
		{ exact: 0 | 1; jaccard: number; precision: number; recall: number };
	function curveByBand(objects: { predicted: { node: string; p: number }[]; gold: string[] }[], cuts?: number[]):
		{ minP: number; exact: number; jaccard: number; precision: number; recall: number; n: number }[];
}

export namespace contract {
	/** `{state, question, options}` OR `content` (the already-rendered string, byte for byte). */
	function validateInput(row: unknown): { ok: true; rendered: boolean };
	/** `coverage` must be PRESENT; `null` is legal and says the path cannot compute it. */
	function validateOutput(row: unknown): { ok: true };
	function sha256(prompt: string): string;
	const KINDS: ('choice' | 'noul' | 'score')[];
	const SOURCES: ('http' | 'logits')[];
	const OUT_REQUIRED: string[];
}

export interface LlamaServerModule {
	createLlamaServerClient(o: { baseUrl: string; nProbs?: number; theta?: number; edges?: number[];
		fetch?: typeof fetch; thinkingOff?: boolean; model?: string }): Client;
	entriesOfLlamaServer(resp: unknown): Entry[];
	asChatResponse(resp: unknown): unknown;
}

export interface NodeLlamaClient extends Client {
	decidePacked(state: string | null, questions: Question[], opts?: { theta?: number }):
		Promise<{ rows: PackedDecision[]; packed: PackedSpec; ms: number; nTokens: number }>;
	tokenize: Tokenize;
	info: { gpu: string | false; gpuLayers: number; vramDelta: number };
	close(): Promise<void>;
}

export interface NodeLlamaCppModule {
	/** `node-llama-cpp` is an OPTIONAL peer, loaded with `import()` (it is pure ESM). */
	createNodeLlamaClient(o: { modelPath: string; gpu?: false | 'auto' | 'cuda' | 'vulkan';
		contextSize?: number; requireGpu?: boolean; theta?: number; edges?: number[];
		placeholder?: string; topK?: number }): Promise<NodeLlamaClient>;
	/** The map carries the WHOLE vocabulary: `limit` bounds detokenisation, `keep` forces the
	 *  letter ids in so that a rare letter is not read as zero mass. */
	probsToEntries(probMap: Map<number, number>, decode: (id: number) => string,
		o?: { limit?: number; keep?: number[] }): Entry[];
	guardVram(o: { requireGpu: boolean; before: number; after: number; gpuLayers: number }): void;
	RAW_SAMPLING: { temperature: number; topK: number; topP: number; minP: number; seed: number };
}

export const backends: {
	'llama-server': LlamaServerModule;
	'node-llama-cpp': NodeLlamaCppModule;
};
