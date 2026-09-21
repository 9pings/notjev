'use strict';
/**
 * chatml.js — LE GABARIT ChatML DE QWEN, RENDU À LA MAIN.
 *
 * Le chemin packed (`/v1/completions`, `/completion`, node-llama-cpp) envoie un PROMPT BRUT : le
 * serveur n'applique aucun gabarit. C'est donc ici qu'est écrite, octet pour octet, la chaîne qui
 * part — la même que celle qu'un `chat/completions` aurait fabriquée, sans quoi le prompt mesuré et
 * le prompt envoyé divergeraient d'un caractère, et avec eux la clé de cache ET les chiffres.
 *
 * Un tour dont le `content` est `null` est un tour OUVERT : c'est le tour de l'assistant que l'on
 * n'a pas refermé, et dont on lit la distribution du premier token. `thinkingOff` y écrit le bloc
 * `<think>\n\n</think>` déjà fermé — l'équivalent brut de `chat_template_kwargs:
 * { enable_thinking: false }` du cœur : sans lui, le premier token d'un modèle à raisonnement est
 * `<think>`, et la lecture ne porte plus sur la réponse.
 */

/**
 * @param turns `[{ role, content }]` — `content: null | undefined` = tour OUVERT (le dernier).
 * @param o `{ thinkingOff?: boolean }`
 * @returns la chaîne ChatML exacte.
 */
function render( turns, o ) {
	let s = '';
	for ( const t of (turns || []) ) {
		if ( t.content === null || t.content === undefined )           // tour ouvert (assistant)
			s += '<|im_start|>' + t.role + '\n' + ((o && o.thinkingOff) ? '<think>\n\n</think>\n\n' : '');
		else s += '<|im_start|>' + t.role + '\n' + String(t.content) + '<|im_end|>\n';
	}
	return s;
}

module.exports = { render };
