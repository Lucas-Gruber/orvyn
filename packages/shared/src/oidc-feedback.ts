/** Browser-safe messages. Redirects carry only these identifiers, never IdP payloads. */
export const oidcFeedback = {
  provisioning_disabled:
    "Your organization has not enabled account creation through single sign-on. Ask an administrator to enable provisioning or arrange access for your existing linked identity.",
  email_unverified:
    "Your identity provider must supply a verified email address before an account can be created. Verify your email with your organization and try again.",
  account_exists:
    "This email already belongs to an Orvyn account. For your security, single sign-on does not automatically link accounts by email. Use the account’s existing sign-in method or contact your administrator.",
  invalid_login:
    "This sign-in attempt expired or could not be verified. Start again from this page in the same browser.",
  provider_changed:
    "Your organization’s sign-in settings changed during login. Start again or contact your administrator if this continues.",
  provider_response:
    "Your identity provider did not return a valid sign-in response. Try again or contact your administrator.",
  provider_unavailable:
    "Your organization’s sign-in service is currently unavailable. Try again shortly or contact your administrator.",
} as const;
export type OidcFeedbackCode = keyof typeof oidcFeedback;
