/**
 * MAIN world, document_start. Sites that pause or bounce you when DevTools
 * opens usually sniff window size, console getters, or inject `debugger`
 * through Function/eval. This makes those checks look like a normal window.
 * A hardcoded debugger in the site's own file still pauses unless you
 * deactivate breakpoints in DevTools (Ctrl+F8).
 */
(function () {
  try {
    if (window.__sgDevtoolsCloak) return;
  } catch (_) {
    return;
  }

  const FLAG = '__SG_DT_CLOAK__';
  let enabled = true;

  window.__sgDevtoolsCloak = true;

  function cloakOn() {
    return enabled;
  }

  function stripDebugger(src) {
    if (typeof src !== 'string' || src.length < 8) return src;
    if (src.indexOf('debugger') === -1 && src.indexOf('Debugger') === -1) return src;
    return src.replace(/\bdebugger\b/gi, '');
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== FLAG) return;
    enabled = data.on !== false;
  });

  function wrapCtor(Native, name) {
    if (typeof Native !== 'function') return Native;
    const Wrapped = function SgCloakFn(...args) {
      if (cloakOn() && args.length && typeof args[args.length - 1] === 'string') {
        args[args.length - 1] = stripDebugger(args[args.length - 1]);
      }
      return Native.apply(null, args);
    };
    try {
      Wrapped.prototype = Native.prototype;
    } catch (_) {
      // ignore
    }
    try {
      Object.defineProperty(Wrapped, 'name', { value: name || Native.name || 'Function' });
      Object.defineProperty(Wrapped, 'length', { value: Native.length });
    } catch (_) {
      // ignore
    }
    try {
      Native.prototype.constructor = Wrapped;
    } catch (_) {
      // ignore
    }
    return Wrapped;
  }

  try {
    window.Function = wrapCtor(window.Function, 'Function');
  } catch (_) {
    // ignore
  }
  try {
    const AsyncFunction = (async function () {}).constructor;
    const wrapped = wrapCtor(AsyncFunction, 'AsyncFunction');
    if (AsyncFunction.prototype) AsyncFunction.prototype.constructor = wrapped;
  } catch (_) {
    // ignore
  }
  try {
    const Gen = function* () {}.constructor;
    wrapCtor(Gen, 'GeneratorFunction');
  } catch (_) {
    // ignore
  }
  try {
    const AsyncGen = async function* () {}.constructor;
    wrapCtor(AsyncGen, 'AsyncGeneratorFunction');
  } catch (_) {
    // ignore
  }

  try {
    const nativeEval = window.eval;
    window.eval = function sgCloakEval(code) {
      if (cloakOn() && typeof code === 'string') code = stripDebugger(code);
      return nativeEval(code);
    };
  } catch (_) {
    // ignore
  }

  function wrapTimer(native) {
    return function sgCloakTimer(handler, timeout, ...rest) {
      if (cloakOn() && typeof handler === 'string') handler = stripDebugger(handler);
      return native.call(this, handler, timeout, ...rest);
    };
  }
  try {
    window.setTimeout = wrapTimer(window.setTimeout.bind(window));
    window.setInterval = wrapTimer(window.setInterval.bind(window));
  } catch (_) {
    // ignore
  }

  try {
    const NativeBlob = window.Blob;
    window.Blob = function SgCloakBlob(parts, opts) {
      if (cloakOn() && Array.isArray(parts)) {
        parts = parts.map((p) => (typeof p === 'string' ? stripDebugger(p) : p));
      }
      return new NativeBlob(parts, opts);
    };
    window.Blob.prototype = NativeBlob.prototype;
  } catch (_) {
    // ignore
  }

  function protoGet(proto, name) {
    try {
      const d = Object.getOwnPropertyDescriptor(proto, name);
      return d && d.get ? d.get : null;
    } catch (_) {
      return null;
    }
  }

  const winProto = Window.prototype;
  const nativeOuterW = protoGet(winProto, 'outerWidth');
  const nativeOuterH = protoGet(winProto, 'outerHeight');
  const nativeInnerW = protoGet(winProto, 'innerWidth');
  const nativeInnerH = protoGet(winProto, 'innerHeight');

  function defineDim(name, getter) {
    try {
      Object.defineProperty(window, name, {
        configurable: true,
        enumerable: true,
        get: getter,
      });
    } catch (_) {
      // ignore
    }
  }

  if (nativeOuterW && nativeInnerW) {
    defineDim('outerWidth', function () {
      try {
        const inner = nativeInnerW.call(this);
        if (!cloakOn()) return nativeOuterW.call(this);
        return inner + 16;
      } catch (_) {
        return nativeOuterW.call(this);
      }
    });
  }
  if (nativeOuterH && nativeInnerH) {
    defineDim('outerHeight', function () {
      try {
        const inner = nativeInnerH.call(this);
        if (!cloakOn()) return nativeOuterH.call(this);
        return inner + 88;
      } catch (_) {
        return nativeOuterH.call(this);
      }
    });
  }

  function looksLikeConsoleTrap(value) {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return false;
    try {
      const keys = ['id', 'toString', 'tagName', 'nodeName', 'className'];
      for (const k of keys) {
        const d = Object.getOwnPropertyDescriptor(value, k);
        if (d && typeof d.get === 'function') return true;
      }
    } catch (_) {
      return true;
    }
    return false;
  }

  function sanitizeArg(value) {
    if (!cloakOn() || !looksLikeConsoleTrap(value)) return value;
    try {
      return Object.prototype.toString.call(value);
    } catch (_) {
      return '[object]';
    }
  }

  const consoleNames = ['log', 'debug', 'info', 'dir', 'dirxml', 'table', 'trace', 'group', 'groupCollapsed'];
  if (window.console) {
    for (const name of consoleNames) {
      const native = window.console[name];
      if (typeof native !== 'function') continue;
      try {
        window.console[name] = function sgCloakConsole(...args) {
          if (!cloakOn()) return native.apply(this, args);
          return native.apply(
            this,
            args.map((a) => sanitizeArg(a))
          );
        };
      } catch (_) {
        // ignore
      }
    }
  }
})();
