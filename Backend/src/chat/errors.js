// Only known error codes cross the service boundary; never forward raw provider errors.
const errors = {
  rag_key_missing: [503, 'NEW_GROQ_API_KEY is missing on the AI service. Add it to the rgit-hack-aiml Render environment and redeploy.'],
  groq_invalid_key: [503, 'The chatbot Groq key is invalid. Update NEW_GROQ_API_KEY on the AI service and redeploy.'],
  groq_rate_limited: [429, 'The chatbot Groq key has reached its rate or quota limit. Try again later or check the key’s limits.'],
  groq_access_denied: [503, 'Groq denied access for the chatbot key. Check its model access and permissions.'],
  groq_request_rejected: [502, 'Groq rejected the request. Check GROQ_MODEL and its context limits on the AI service.'],
  groq_timeout: [504, 'Groq took too long to answer. Please retry.'],
  rag_invalid_answer: [502, 'The AI returned an answer without valid source citations. Please retry.'],
  groq_unavailable: [502, 'Groq is unavailable. Please retry.'],
};
export function describeChatFailure(status, data) {
  let code = data?.detail?.code;
  if (data?.detail === 'NEW_GROQ_API_KEY is not configured for project chat.') code = 'rag_key_missing';
  if (errors[code]) return { status: errors[code][0], error: code, message: errors[code][1] };
  if (status === 404) return { status: 503, error: 'chat_not_deployed', message: 'The AI chat endpoint is not deployed. Deploy the latest aiml code and try again.' };
  if (status === 422) return { status: 502, error: 'chat_payload_rejected', message: 'The AI service rejected the chat context. Ensure Backend and aiml use the latest matching deployments.' };
  return { status: 502, error: 'chat_ai_failed', message: 'The AI service could not answer. Check the project-chat failure in the AI service logs or redeploy the latest diagnostic code.' };
}
