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
	log?: ((...a: unknown[]) => void) | null }): import('http').Server;

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
