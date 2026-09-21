'use strict';
/** Une erreur typée : `code` est le contrat, `message` est pour l'humain. Copie de lib/client.js#fail. */
function fail( code, message, extra ) {
	const e = new Error(message);
	e.code = code;
	if ( extra ) Object.assign(e, extra);
	return e;
}
module.exports = { fail };
