import { useEffect, useRef } from 'react'
import { db, nextChannelSuffix } from './supabase'

// Shared realtime plumbing for the manager review queues (backlog #22).
// Subscribes to INSERT + UPDATE on one table with the house auto-reconnect
// idiom (2s retry on CHANNEL_ERROR / TIMED_OUT / CLOSED), unique channel
// names via nextChannelSuffix(), and try/catch around .subscribe so a
// realtime throw degrades to "no live updates" instead of killing the render.
//
// onEvent(eventType, payload) is held in a ref, so the channel subscribes
// exactly once per mount while the handler always sees the caller's latest
// state (e.g. a filter-dependent reload callback) — no resubscribe churn
// when the handler identity changes.
export default function useRealtimeQueue(table, { channelPrefix, onEvent } = {}) {
  const handlerRef = useRef(onEvent)
  handlerRef.current = onEvent

  useEffect(() => {
    let channel = null
    let reconnectTimer = null
    let cancelled = false

    const setup = () => {
      if (cancelled) return
      if (channel) {
        try { channel.unsubscribe() } catch {}
      }
      // Unique name per setup so a reconnect (or a re-mount on tab switch)
      // doesn't collide with a stale channel that hasn't been GC'd yet.
      try {
        channel = db.channel((channelPrefix || `queue_${table}_`) + nextChannelSuffix())
          .on('postgres_changes',
            { event: 'INSERT', schema: 'public', table },
            payload => handlerRef.current?.('INSERT', payload))
          .on('postgres_changes',
            { event: 'UPDATE', schema: 'public', table },
            payload => handlerRef.current?.('UPDATE', payload))
          .subscribe(status => {
            // Reconnect if the channel drops for any reason
            if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
              if (reconnectTimer) clearTimeout(reconnectTimer)
              reconnectTimer = setTimeout(setup, 2000)
            }
          })
      } catch (e) {
        console.warn(`Realtime subscribe failed (${table}):`, e)
      }
    }

    setup()

    return () => {
      cancelled = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      if (channel) {
        try { channel.unsubscribe() } catch {}
      }
    }
  }, [table, channelPrefix])
}
