// Pubsub, answered from the node's pubsub routes. kubo-rpc-client wraps topics, data and sequence numbers in
// multibase base64url (`u` and then the text); the node speaks plain UTF-8 topics in the query and standard base64 in
// its messages, so each way across is converted here.

import { viaNode } from '../errors.js'
import { decodeRpcText, emptyResponse, encodeRpcBytes, encodeRpcText, fromBase64, jsonResponse, KuboError } from '../wire.js'

const TEXT = new TextEncoder()

/**
 * One of the node's messages as kubo prints it: `{"from","data","seqno","topicIDs"}`, binary fields in multibase.
 * @param {string} line
 */
function toKuboMessage (line) {
  /** @type {{ from?: string, data?: string, seqno?: string, topicIDs?: string[] }} */
  let message
  try { message = JSON.parse(line) } catch { return '' }
  if (message.from == null || message.data == null) return ''
  const seqno = message.seqno == null || message.seqno === '' ? new Uint8Array(8) : fromBase64(message.seqno)
  return `${JSON.stringify({
    from: message.from,
    data: encodeRpcBytes(fromBase64(message.data)),
    seqno: encodeRpcBytes(seqno),
    topicIDs: (message.topicIDs ?? []).map(encodeRpcText)
  })}\n`
}

/** The node's message stream, line by line, as kubo's. @param {ReadableStream<Uint8Array>} body */
function kuboMessages (body) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  return new ReadableStream({
    async pull (controller) {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) { controller.close(); return }
        buffered += decoder.decode(value, { stream: true })
        const lines = buffered.split('\n')
        buffered = lines.pop() ?? ''
        const out = lines.map(toKuboMessage).join('')
        if (out !== '') { controller.enqueue(TEXT.encode(out)); return }
      }
    },
    cancel (reason) { return reader.cancel(reason) }
  })
}

/** @param {{ node: ReturnType<typeof import('../node-client.js').createNodeClient> }} deps */
export function pubsubRoutes ({ node }) {
  /** @param {import('../facade.js').Context} ctx */
  const topicOf = (ctx) => {
    const arg = ctx.args[0]
    if (arg === undefined || arg === '') throw new KuboError('argument "topic" is required')
    return decodeRpcText(arg)
  }

  return {
    /** Answered once the node has taken the subscription, and then streams until the client leaves. @param {import('../facade.js').Context} ctx */
    async 'pubsub/sub' (ctx) {
      const upstream = await viaNode(() => node.pubsubSubscribe(topicOf(ctx), ctx.signal))
      return new Response(upstream.body == null ? null : kuboMessages(upstream.body), {
        status: 200, headers: { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff', 'X-Stream-Output': '1' }
      })
    },

    /** @param {import('../facade.js').Context} ctx */
    async 'pubsub/pub' (ctx) {
      const topic = topicOf(ctx)
      const data = (await ctx.parts())[0]
      await viaNode(() => node.pubsubPublish(topic, data?.body ?? new Uint8Array(0), ctx.signal))
      return emptyResponse()
    },

    async 'pubsub/ls' () {
      return jsonResponse({ Strings: (await viaNode(() => node.pubsubTopics())).map(encodeRpcText) })
    },

    /** @param {import('../facade.js').Context} ctx */
    async 'pubsub/peers' (ctx) {
      const topic = ctx.args[0] === undefined ? undefined : decodeRpcText(ctx.args[0])
      return jsonResponse({ Strings: await viaNode(() => node.pubsubPeers(topic)) })
    }
  }
}
