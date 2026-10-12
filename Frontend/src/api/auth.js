const base = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '');
export async function authenticate(mode, values) {
  let response;
  try {
    response = await fetch(`${base}/auth/${mode}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(mode === 'register' ? {
        name: values.username.trim(),
        email: values.email.trim(),
        password: values.password
      } : {
        email: values.email.trim(),
        password: values.password
      }),
      signal: AbortSignal.timeout(15000)
    });
  } catch {
    throw new Error('We couldn’t reach Over2u. Please check your connection and try again.');
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(response.status === 409 ? 'An account with this email already exists. Please sign in.' : response.status === 401 ? 'Your email or password is incorrect.' : response.status === 400 ? 'Please check your account details and try again.' : 'Over2u is unavailable right now. Please try again shortly.');
    error.field = response.status === 409 ? 'email' : null;
    throw error;
  }
  if (!data?.token || !data?.user) throw new Error('Over2u returned an unexpected response. Please try signing in.');
  window.dispatchEvent(new CustomEvent('relay:authenticated', {
    detail: data
  }));
  return data;
}
