/*\
title: $:/core/modules/savers/put.js
type: application/javascript
module-type: saver

No WebDAV saving: a published wiki is a static page on IPFS, and the editing
frame's changes are kept by the editor page. TiddlyWiki's PUT saver would only
probe the page's own address with a request every host here refuses.

\*/

"use strict";

exports.canSave = function() {
	return false;
};

exports.create = function() {
	return null;
};
