// Workaround, deletable when Orivon's Node shim answers a run-time `require` of these builtins and the members below.
// pkc-js's bundled chunks load Node builtins with `createRequire(import.meta.url)`, which the shim answers from a
// registry that holds neither `worker_threads`, `sqlite` nor `stream/web`; an app registers them itself.

/**
 * The `require('worker_threads')` answer: a plain object of the members the shim implements, because the shim's own
 * default export throws for a member it lacks where Node gives `undefined`, and undici feature-detects
 * `markAsUncloneable`, which the shim does not have.
 * @param {Record<string, any>} wt the shim's `worker_threads` namespace
 */
export function workerThreadsFor (wt) {
  return {
    Worker: wt.Worker,
    isMainThread: wt.isMainThread,
    threadId: wt.threadId,
    parentPort: wt.parentPort,
    workerData: wt.workerData,
    resourceLimits: wt.resourceLimits,
    SHARE_ENV: wt.SHARE_ENV,
    MessageChannel: wt.MessageChannel,
    MessagePort: wt.MessagePort,
    BroadcastChannel: wt.BroadcastChannel,
    getEnvironmentData: wt.getEnvironmentData,
    setEnvironmentData: wt.setEnvironmentData,
    markAsUntransferable: wt.markAsUntransferable,
    markAsUncloneable: (/** @type {unknown} */ _object) => {},
    isMarkedAsUntransferable: wt.isMarkedAsUntransferable
  }
}

/** The `require('stream/web')` answer, from the platform's own classes. @param {Record<string, any>} scope `globalThis` */
export function streamWebFor (scope) {
  return Object.fromEntries(['ReadableStream', 'WritableStream', 'TransformStream', 'ByteLengthQueuingStrategy', 'CountQueuingStrategy', 'TextEncoderStream', 'TextDecoderStream'].map((name) => [name, scope[name]]))
}
