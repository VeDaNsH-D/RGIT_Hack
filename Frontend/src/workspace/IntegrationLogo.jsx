export default function IntegrationLogo({ name }) {
  const asset = name === 'mail' ? 'gmail' : name
  return <img className="integration-logo" src={`/images/integrations/${asset}.svg`} alt="" width="32" height="32"/>
}
