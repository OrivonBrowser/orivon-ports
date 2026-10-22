/*\
title: $:/core/modules/savers/put.js
type: application/javascript
module-type: saver

No WebDAV saving in the editing frame: the editor page keeps every change,
and the PUT saver's probe of the frame's own address is a request the
sandboxed frame is refused anyway.

\*/

"use strict";

exports.canSave = function() {
	return false;
};

exports.create = function() {
	return null;
};
