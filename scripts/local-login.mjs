#!/usr/bin/env node
// Local-only browser bootstrap: the server mints a one-time viewer handoff,
// and this origin redeems it into its own localStorage. Not a production route.
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'

const backendOrigin = process.env.HARNESS_LOCAL_BACKEND || 'http://10.126.126.10:8085'
const authSessionPath = process.env.HARNESS_AUTH_SESSION || `${homedir()}/.harness/auth/session.json`

export async function localViewerHandoff() {
  const session = JSON.parse(readFileSync(authSessionPath, 'utf8'))
  const post = async (path, body, token) => await fetch(`${backendOrigin}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })

  let accessToken = session.accessToken
  if (!session.expiresAt || Date.now() + 30_000 >= session.expiresAt) {
    if (!session.refreshToken) throw new Error('local computer session has no refresh token')
    const refreshResponse = await post('/api/auth/refresh', { refreshToken: session.refreshToken })
    const refreshPayload = await refreshResponse.json().catch(() => ({}))
    if (!refreshResponse.ok || !refreshPayload?.data?.token) throw new Error('computer session refresh failed')
    const tokens = refreshPayload.data
    session.accessToken = tokens.token
    if (tokens.refreshToken) session.refreshToken = tokens.refreshToken
    session.expiresAt = Date.now() + (tokens.expiresIn ?? 3600) * 1000
    session.updatedAt = Date.now()
    const temp = `${authSessionPath}.tmp.${process.pid}`
    writeFileSync(temp, JSON.stringify(session), { mode: 0o600 })
    chmodSync(temp, 0o600)
    renameSync(temp, authSessionPath)
    accessToken = tokens.token
  }

  const response = await post('/api/auth/handoff', {}, accessToken)
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || !payload?.data?.code) throw new Error('viewer handoff failed')
  return { code: payload.data.code }
}

export function localLoginPage(code) {
  const backend = JSON.stringify(backendOrigin)
  const handoff = JSON.stringify(code)
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Local Harness sign-in</title>
<script>
(async () => {
  const backend = ${backend}
  try {
    const response = await fetch(backend + '/api/auth/handoff/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: ${handoff}, label: 'Local browser' }),
    })
    const payload = await response.json()
    const data = payload?.data
    if (!response.ok || !data?.token) throw new Error(payload?.error?.message || 'sign-in failed')
    const prefix = 'harness.web.v1.'
    localStorage.setItem(prefix + 'auth_access_token', data.token)
    localStorage.setItem(prefix + 'auth_refresh_token', data.refreshToken || '')
    localStorage.setItem(prefix + 'auth_autonomous_env', data.autonomousEnv || 'prod')
    localStorage.setItem(prefix + 'auth_access_token_expires_at', String(Date.now() + (data.expiresIn || 3600) * 1000))
    localStorage.removeItem(prefix + 'auth_sso_client_id')
    localStorage.setItem(prefix + 'persistent_credentials', '1')
    location.replace('/')
  } catch (error) {
    document.body.textContent = 'Local sign-in failed: ' + error.message
  }
})()
</script>`
}
