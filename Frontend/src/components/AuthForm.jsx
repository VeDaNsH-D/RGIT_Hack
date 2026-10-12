import { useRef, useState } from 'react';
import { authenticate } from '../api/auth';
import GoogleSignIn from './GoogleSignIn';
export default function AuthForm({
  mode,
  onSwitch,
  onAuthenticated
}) {
  const signup = mode === 'register';
  const [values, setValues] = useState({
    username: '',
    email: '',
    password: ''
  });
  const [errors, setErrors] = useState({});
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [visible, setVisible] = useState(false);
  const [policy, setPolicy] = useState(null);
  const lock = useRef(false);
  async function submit(event) {
    event.preventDefault();
    if (lock.current) return;
    const next = {};
    if (signup && !values.username.trim()) next.username = 'Please enter a username.';else if (signup && values.username.trim().length > 200) next.username = 'Use 200 characters or fewer.';
    if (!values.email.trim()) next.email = 'Please enter your work email.';else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email.trim())) next.email = 'Enter a valid email address.';
    if (!values.password) next.password = 'Please enter a password.';else if (signup && values.password.length < 8) next.password = 'Use at least 8 characters.';else if (values.password.length > 200) next.password = 'Use 200 characters or fewer.';
    setErrors(next);
    setFeedback('');
    if (Object.keys(next).length) {
      event.currentTarget.elements[Object.keys(next)[0]]?.focus();
      return;
    }
    lock.current = true;
    setBusy(true);
    try {
      onAuthenticated(await authenticate(mode, values));
    } catch (error) {
      if (error.field) setErrors({
        [error.field]: error.message
      });else setFeedback(error.message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  function field(name, label, placeholder, type = 'text') {
    return <div className="field"><label htmlFor={name}>{label}<span aria-hidden="true"> *</span></label><div className="input-wrap"><input id={name} name={name} type={name === 'password' && visible ? 'text' : type} placeholder={placeholder} value={values[name]} disabled={busy} required maxLength={name === 'email' ? 254 : 200} autoComplete={name === 'password' ? signup ? 'new-password' : 'current-password' : name === 'email' ? 'email' : 'username'} aria-invalid={Boolean(errors[name])} aria-describedby={errors[name] ? `${name}-error` : name === 'password' && signup ? 'password-help' : undefined} onChange={e => {
          setValues({
            ...values,
            [name]: e.target.value
          });
          setErrors({
            ...errors,
            [name]: undefined
          });
          setFeedback('');
        }} />{name === 'password' && <button className="password-toggle" type="button" aria-label={visible ? 'Hide password' : 'Show password'} aria-pressed={visible} onClick={() => setVisible(!visible)}>{visible ? 'Hide' : 'Show'}</button>}</div>{errors[name] && <p className="field-error" id={`${name}-error`}>{errors[name]}</p>}</div>;
  }
  return <><div className="form-kicker"><span aria-hidden="true">⑂</span> YOUR NEXT CHAPTER STARTS HERE</div><h2>{signup ? 'Get started with Over2u' : 'Welcome back to Over2u'}</h2><p className="form-intro">{signup ? 'Great handoffs start with a connected team.' : 'Pick up right where your team left off.'}</p><GoogleSignIn disabled={busy}/><form noValidate onSubmit={submit} aria-busy={busy}>{signup && field('username', 'Username', 'anuj_ghugarkar')}{field('email', 'Work email', 'you@company.com', 'email')}{field('password', 'Password', signup ? 'Create a strong password' : 'Enter your password', 'password')}{signup && <p className="password-help" id="password-help">Use a strong password to keep your account secure.<br />At least 8 characters.</p>}{feedback && <p className="submission-error" role="alert">{feedback}</p>}<button className="primary-button" disabled={busy} type="submit">{busy ? signup ? 'Creating your account…' : 'Signing in…' : signup ? 'Create your Over2u account' : 'Sign in to Over2u'} {!busy && <span aria-hidden="true">→</span>}</button></form><p className="account-switch">{signup ? 'Already have an account?' : 'New to Over2u?'} <button disabled={busy} onClick={() => onSwitch(signup ? 'login' : 'register')}>{signup ? 'Sign in' : 'Create an account'} ↗</button></p>{signup && <p className="terms">By creating an account, you agree to Over2u’s <button onClick={() => setPolicy('Terms of Service')}>Terms of Service</button> and <button onClick={() => setPolicy('Privacy Policy')}>Privacy Policy</button>.</p>}{policy && <div className="policy-notice" role="status"><strong>{policy}</strong><p>Over2u’s {policy.toLowerCase()} has not been published in this application yet.</p><button onClick={() => setPolicy(null)}>Dismiss</button></div>}<div className="form-bottom">◇ &nbsp; A clear start. A confident handoff.</div></>;
}
