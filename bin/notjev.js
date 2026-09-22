#!/usr/bin/env node
'use strict';
/**
 * notjev — CLI.
 *
 *   notjev decide  --state <file|text|-> --question "…" --option ID[=description] … [--theta 0.5]
 *   notjev noul    --state <file|text|-> --question "…" [--yes ID[=desc]] [--no ID[=desc]]
 *   notjev score   --state <file|text|-> --question "…" [--min 1] [--max 5]
 *   notjev prompt  …same flags…            print the EXACT string, send nothing
 *   notjev replay  <recording.json> [--truth gold] [--theta 0] [--positive CODE] [--rows]
 *   notjev serve   [--port 8787] [--host 127.0.0.1]
 *
 * Server flags (or env): --base-url NOTJEV_BASE_URL · --model NOTJEV_MODEL · --api-key NOTJEV_API_KEY
 *                        --theta NOTJEV_THETA
 * Exit codes: 0 a verdict · 3 UNDECIDED (margin under theta) · 4 DEGRADED (no option mass) · 1 error.
 * `--json` prints the whole result; without it, one readable line per question.
 */

const fs = require('fs');
const { createClient } = require('../lib/client');
const { createServer } = require('../lib/server');
const { replay, report } = require('../lib/replay');
const readout = require('../lib/readout');
const pkg = require('../package.json');

/* ── ARGS ─────────────────────────────────────────────────────────────────────────────────── */

function parse( argv ) {
	const out = { _: [], opts: [] };
	for ( let i = 0; i < argv.length; i++ ) {
		const a = argv[i];
		if ( a.slice(0, 2) !== '--' ) { out._.push(a); continue; }
		const eq = a.indexOf('=');
		const key = (eq >= 0 ? a.slice(2, eq) : a.slice(2));
		const val = eq >= 0 ? a.slice(eq + 1)
			: (argv[i + 1] !== undefined && argv[i + 1].slice(0, 2) !== '--') ? argv[++i] : true;
		if ( key === 'option' ) out.opts.push(val);
		else if ( out[key] === undefined ) out[key] = val;
		else out[key] = [].concat(out[key], val);
	}
	return out;
}

/** `--state` is a FILE when the path exists, `-` for stdin, otherwise the literal text. */
function stateOf( v ) {
	if ( v === undefined || v === true ) return undefined;
	if ( v === '-' ) return fs.readFileSync(0, 'utf8');
	try { if ( fs.existsSync(v) && fs.statSync(v).isFile() ) return fs.readFileSync(v, 'utf8'); } catch ( e ) { /* literal */ }
	return String(v);
}

/** `ID=description` -> `{ id, description }` · `ID` -> `ID`. The description CHANGES the prompt. */
function optionOfArg( s ) {
	const t = String(s);
	const i = t.indexOf('=');
	return i < 0 ? t : { id: t.slice(0, i), description: t.slice(i + 1) };
}

function clientOf( a ) {
	return createClient({
		baseUrl    : a['base-url'] || a.baseUrl,
		model      : a.model,
		apiKey     : a['api-key'] || a.apiKey,
		theta      : a.theta !== undefined ? Number(a.theta) : undefined,
		topLogprobs: a['top-logprobs'] !== undefined ? Number(a['top-logprobs']) : undefined,
		maxTokens  : a['max-tokens'] !== undefined ? Number(a['max-tokens']) : undefined,
		timeoutMs  : a.timeout !== undefined ? Number(a.timeout) : undefined,
		retries    : a.retries !== undefined ? Number(a.retries) : undefined,
		system     : a.system === true ? undefined : a.system,
		instruction: a.instruction === true ? undefined : a.instruction,
		// `--no-template-kwargs` for servers that reject unknown body fields (OpenAI).
		templateKwargs: (a['no-template-kwargs'] || a['template-kwargs'] === 'none') ? null : undefined,
	});
}

function questionOf( a, kind ) {
	const q = {
		state      : stateOf(a.state),
		question   : a.question === true ? '' : (a.question || ''),
		instruction: a.instruction === true ? undefined : a.instruction,
	};
	if ( kind === 'noul' ) {
		const pair = (a.yes !== undefined || a.no !== undefined)
			? { yes: optionOfArg(a.yes === undefined ? 'true' : a.yes), no: optionOfArg(a.no === undefined ? 'false' : a.no) }
			: true;
		q.noul = pair;
	} else if ( kind === 'score' ) {
		q.score = { min: a.min === undefined ? 1 : Number(a.min), max: a.max === undefined ? 5 : Number(a.max) };
	} else {
		if ( !a.opts.length )
			throw Object.assign(new Error('notjev: no `--option`. A readout needs a CLOSED codomain: '
				+ '--option MEME --option AUTRE (or `ID=description`).'), { code: 'NOTJEV_NO_FORM' });
		q.options = a.opts.map(optionOfArg);
	}
	return q;
}

function line( r ) {
	const pc = ( x ) => (x === null || x === undefined) ? '—' : Number(x).toFixed(3);
	return (r.degraded ? 'DEGRADED' : r.undecided ? 'UNDECIDED' : String(r.choice))
		+ '  p1 ' + pc(r.p1) + '  margin ' + pc(r.margin) + '  band ' + r.band
		+ '  coverage ' + pc(r.coverage) + '  theta ' + r.theta + '  ' + (r.ms === null ? '' : r.ms + ' ms')
		+ (r.expectation !== undefined && r.expectation !== null ? '  E ' + pc(r.expectation) : '');
}

function exitOf( r ) { return r.degraded ? 4 : r.undecided ? 3 : 0; }

function jsonOf( r, withRaw ) {
	const out = {};
	for ( const k of Object.keys(r) ) {
		if ( typeof r[k] === 'function' ) continue;
		if ( !withRaw && (k === 'raw' || k === 'entries' || k === 'request') ) continue;
		out[k] = r[k];
	}
	return out;
}

/* ── COMMANDS ─────────────────────────────────────────────────────────────────────────────── */

const USAGE = [
	'  notjev decide  --state <file|text|-> --question "…" --option ID[=description] … [--theta 0.5] [--json]',
	'  notjev noul    --state <file|text|-> --question "…" [--yes ID[=desc]] [--no ID[=desc]]',
	'  notjev score   --state <file|text|-> --question "…" [--min 1] [--max 5]',
	'  notjev prompt  …same flags…                 print the EXACT string, send nothing',
	'  notjev replay  <recording.json> [--truth gold] [--theta 0] [--positive CODE] [--summary]',
	'  notjev serve   [--port 8787] [--host 127.0.0.1]',
	'',
	'  server: --base-url (NOTJEV_BASE_URL) --model (NOTJEV_MODEL) --api-key (NOTJEV_API_KEY)',
	'          --theta (NOTJEV_THETA) --top-logprobs --max-tokens --timeout --retries',
	'          --no-template-kwargs   (servers that reject unknown body fields, e.g. OpenAI)',
	'  output: --json [--raw] · --print-prompt (to stderr)',
	'  exit  : 0 a verdict · 3 UNDECIDED (margin under theta) · 4 DEGRADED (no option mass) · 1 error',
].join('\n');

async function main( argv ) {
	const cmd = argv[0];
	const a = parse(argv.slice(1));

	if ( !cmd || cmd === 'help' || a.help ) { console.log('notjev ' + pkg.version + '\n\n' + USAGE); return 0; }
	if ( cmd === 'version' || a.version ) { console.log(pkg.version); return 0; }

	if ( cmd === 'prompt' ) {
		const kind = a.score !== undefined ? 'score' : (a.yes !== undefined || a.no !== undefined || a.noul) ? 'noul' : 'choice';
		const q = questionOf(a, kind);
		// no server needed to print the string: that is the whole point of a pure renderer
		const form = require('../lib/client').formOf(q);
		process.stdout.write(readout.renderTurn({
			state: q.state, question: q.question, options: form.texts, instruction: q.instruction }) + '\n');
		return 0;
	}

	if ( cmd === 'decide' || cmd === 'noul' || cmd === 'score' ) {
		const client = clientOf(a);
		const q = questionOf(a, cmd === 'decide' ? 'choice' : cmd);
		if ( a['print-prompt'] ) process.stderr.write(client.prompt(q) + '\n');
		const r = await client.decide(q);
		if ( a.json ) console.log(JSON.stringify(jsonOf(r, !!a.raw), null, 1));
		else console.log(line(r));
		if ( !a.json && r.degraded ) console.error('  ' + r.explain());
		return exitOf(r);
	}

	if ( cmd === 'replay' ) {
		const file = a._[0];
		if ( !file ) throw new Error('notjev replay: give the recording file (JSON: `{ results: [{ options, resp }] }`).');
		const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
		const { rows, meta } = replay(rec, {
			theta   : a.theta !== undefined ? Number(a.theta) : 0,
			truth   : a.truth === true ? undefined : a.truth,
			options : a.opts.length ? a.opts.map(optionOfArg).map(( x ) => (typeof x === 'string' ? x : x.id) ) : undefined,
		});
		if ( a.json ) { console.log(JSON.stringify({ meta: meta, rows: rows }, null, 1)); return 0; }
		if ( !a.summary )
			for ( const r of rows )
				console.log([r.id, r.top, r.p1.toFixed(6), r.margin.toFixed(6), r.band, r.prior,
					r.coverage.toFixed(6), r.degraded, r.undecided,
					r.expected === undefined ? '' : r.expected].join('\t'));
		const rep = report(rows, { positive: a.positive === true ? undefined : a.positive });
		console.log('\n# n=' + rep.n + ' truth=' + (meta.truth || '—') + ' coverage='
			+ rep.coverage.toFixed(6) + ' degraded=' + rep.degraded + ' spaced=' + rep.spaced.toFixed(6));
		if ( rep.withTruth ) {
			const acc = rep.accuracy;
			console.log('# accuracy=' + acc.accuracy.toFixed(6) + ' (' + acc.right + '/' + acc.n
				+ ')  null-arm=' + acc.nullArm.accuracy.toFixed(6) + ' ("' + acc.nullArm.klass + '")'
				+ '  oracle=1.000000  ECE=' + (rep.ece.ece === null ? '—' : rep.ece.ece.toFixed(6)));
			if ( rep.f1 ) console.log('# F1(' + a.positive + ')=' + (rep.f1.f1 === null ? '—' : rep.f1.f1.toFixed(6))
				+ ' P=' + (rep.f1.p === null ? '—' : rep.f1.p.toFixed(6)) + ' R=' + (rep.f1.r === null ? '—' : rep.f1.r.toFixed(6))
				+ ' TP=' + rep.f1.tp + ' FP=' + rep.f1.fp + ' FN=' + rep.f1.fn);
			console.log('# theta\tdecided\tcoverage\tprecision');
			for ( const s of rep.sweep )
				console.log('# ' + s.theta.toFixed(1) + '\t' + s.decided + '\t'
					+ (s.coverage === null ? '—' : s.coverage.toFixed(6)) + '\t'
					+ (s.precision === null ? '—' : s.precision.toFixed(6)));
			for ( const b of rep.bands )
				console.log('# band ' + b.band + '\tn=' + b.n + '\tp1=' + (b.p1 === null ? '—' : b.p1.toFixed(6))
					+ '\taccuracy=' + (b.accuracy === null ? 'EMPTY MEASURE' : b.accuracy.toFixed(6)));
		}
		return 0;
	}

	if ( cmd === 'serve' ) {
		const port = Number(a.port || process.env.NOTJEV_PORT || 8787);
		const host = a.host || process.env.NOTJEV_HOST || '127.0.0.1';
		/* `NOTJEV_API_KEY` guards the POST routes too: one key, two doors (upstream, callers). */
		const apiKey = a['api-key'] || a.apiKey || process.env.NOTJEV_API_KEY || null;
		const server = createServer({
			baseUrl: a['base-url'] || a.baseUrl,
			model  : a.model,
			apiKey : apiKey,
			theta  : a.theta !== undefined ? Number(a.theta) : undefined,
			templateKwargs: (a['no-template-kwargs'] || a['template-kwargs'] === 'none') ? null : undefined,
		});
		await new Promise(( r ) => server.listen(port, host, r) );
		console.log('notjev serve · http://' + host + ':' + port + ' -> ' + server.notjev.client.baseUrl
			+ ' · model ' + (server.notjev.client.model || '(server default)')
			+ ' · theta ' + server.notjev.client.theta
			+ (apiKey ? ' · bearer-guarded' : ''));
		console.log('  POST /v1/decide  { "state": "…", "questions": [{ "question": "…", "options": ["A","B"] }] }');
		console.log('  POST /v1/systemone  { "state": "…", "questions": { "q": { "type": "choice", "instructions": "…", "criteria": { … } } } }');
		return new Promise(() => {} ); // runs until killed
	}

	throw Object.assign(new Error('notjev: unknown command "' + cmd + '".\n\n' + USAGE), { code: 'NOTJEV_NO_CMD' });
}

main(process.argv.slice(2)).then(( code ) => { process.exitCode = code || 0; })
	.catch(( e ) => { console.error('notjev: ' + ((e && e.message) || e)); process.exitCode = 1; });
