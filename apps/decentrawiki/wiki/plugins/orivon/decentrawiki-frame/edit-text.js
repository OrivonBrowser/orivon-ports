/*\
title: $:/core/modules/widgets/edit-text.js
type: application/javascript
module-type: widget

The edit-text widget of the editing frame: the simple engine with the
toolbar as well. TiddlyWiki's own framed engine writes into an iframe it
makes, which a frame sandboxed without allow-same-origin may not touch, so
the editor would not start; the simple engine runs the same toolbar
operations on a textarea in the page itself.

\*/

"use strict";

var editTextWidgetFactory = require("$:/core/modules/editor/factory.js").editTextWidgetFactory,
	SimpleEngine = require("$:/core/modules/editor/engines/simple.js").SimpleEngine;

exports["edit-text"] = editTextWidgetFactory(SimpleEngine,SimpleEngine);
