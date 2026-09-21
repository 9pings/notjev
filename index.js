'use strict';
/**
 * notjev — read a decision out of the next-token distribution, instead of making a model write it.
 *
 * One `chat/completions` request, `max_tokens: 1`, `logprobs: true`: the mass of the option
 * letters, renormalised, gives a verdict AND a probability — therefore a margin, therefore a
 * tunable abstention. Server-agnostic (vLLM, llama.cpp, Ollama, OpenAI), zero runtime dependency.
 */

const readout = require('./lib/readout');
const metrics = require('./lib/metrics');
const { createClient, readResponse, formOf, optionOf } = require('./lib/client');
const { createServer } = require('./lib/server');
const { replay, report } = require('./lib/replay');
const logits = require('./lib/logits');
const tokenizer = require('./lib/tokenizer');
const packed = require('./lib/packed');
const chatml = require('./lib/chatml');
const calibration = require('./lib/calibration');

module.exports = {
	// the client (does I/O)
	createClient,
	createServer,
	// the pure reading — replay, offline analysis, tests
	readResponse,
	replay,
	report,
	formOf,
	optionOf,
	// the pure module, whole
	readout,
	metrics,
	logits,
	tokenizer,
	packed,
	chatml,
	calibration,
	// the pieces most callers reach for directly
	renderTurn  : readout.renderTurn,
	chatParams  : readout.chatParams,
	entriesOf   : readout.entriesOf,
	distribution: readout.distribution,
	bandOf      : readout.bandOf,
	snap        : readout.snap,
	INSTRUCTION : readout.INSTRUCTION,
	LETTERS     : readout.LETTERS,
	MAX_OPTIONS : readout.MAX_OPTIONS,
	BANDS       : readout.BANDS,
	BAND_EDGES  : readout.BAND_EDGES,
	THETA_DEFAULT: readout.THETA_DEFAULT,
	UNDECIDED   : readout.UNDECIDED,
};
