/**
 * Official LLM Provider Icons
 *
 * SVG logo marks for each supported LLM provider.
 * Used in the model catalog browse UI and provider badges.
 */

interface IconProps {
  className?: string;
}

export function OpenAIIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365 2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
    </svg>
  );
}

export function AnthropicIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M17.304 3.541h-3.483l6.15 16.918h3.482zm-10.608 0L.546 20.459H4.1l1.262-3.471h6.478l1.263 3.471h3.554L10.507 3.541zm.136 10.834L9.021 8.07l2.189 6.305z" />
    </svg>
  );
}

export function AzureIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 96 96" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M33.338 6.544h26.038l-27.03 80.455a4.152 4.152 0 0 1-3.933 2.824H8.149a4.145 4.145 0 0 1-3.928-5.47L29.404 9.37a4.152 4.152 0 0 1 3.934-2.825z"
        fill="url(#azure-a)"
      />
      <path
        d="M71.175 60.261H41.29a1.911 1.911 0 0 0-1.305 3.309l26.532 24.764a4.171 4.171 0 0 0 2.846 1.121h17.937L71.175 60.261z"
        fill="#0078D4"
      />
      <path
        d="M33.338 6.544a4.118 4.118 0 0 0-3.943 2.879L4.252 84.09a4.143 4.143 0 0 0 3.908 5.538h20.787a4.443 4.443 0 0 0 3.41-2.9l5.014-14.777 17.91 16.705a4.237 4.237 0 0 0 2.666.972h18.36L59.103 60.261l-29.781-.007L59.36 6.544H33.338z"
        fill="url(#azure-b)"
      />
      <path
        d="M66.595 9.364a4.145 4.145 0 0 0-3.928-2.82H33.648a4.146 4.146 0 0 1 3.928 2.82l25.184 75.08a4.146 4.146 0 0 1-3.928 5.472h29.02a4.146 4.146 0 0 0 3.927-5.472L66.595 9.364z"
        fill="url(#azure-c)"
      />
      <defs>
        <linearGradient
          id="azure-a"
          x1="46.153"
          y1="10.652"
          x2="14.704"
          y2="93.076"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#114A8B" />
          <stop offset="1" stopColor="#0669BC" />
        </linearGradient>
        <linearGradient
          id="azure-b"
          x1="54.917"
          y1="53.456"
          x2="47.756"
          y2="55.862"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopOpacity=".3" />
          <stop offset=".071" stopOpacity=".2" />
          <stop offset=".321" stopOpacity=".1" />
          <stop offset=".623" stopOpacity=".05" />
          <stop offset="1" stopOpacity="0" />
        </linearGradient>
        <linearGradient
          id="azure-c"
          x1="49.414"
          y1="7.917"
          x2="78.753"
          y2="90.081"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#3CCBF4" />
          <stop offset="1" stopColor="#2892DF" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export function GoogleIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  );
}

export function GeminiIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M12 24A14.304 14.304 0 0 0 0 12 14.304 14.304 0 0 0 12 0a14.305 14.305 0 0 0 12 12 14.305 14.305 0 0 0-12 12z"
        fill="url(#gemini-grad)"
      />
      <defs>
        <linearGradient
          id="gemini-grad"
          x1="0"
          y1="12"
          x2="24"
          y2="12"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#1C7CEF" />
          <stop offset="1" stopColor="#A040EF" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export function GroqIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg className={className} viewBox="66 26 68 68" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="100" cy="60" r="36" fill="#E84C10" />
      <path d="M105 30 L88 62 L100 62 L95 90 L114 52 L101 52 Z" fill="white" />
    </svg>
  );
}

export function CohereIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M8.545 13.833c.592 0 2.14.085 3.743.917 1.394.722 3.075 1.417 5.378 1.417 2.481 0 3.976-.993 4.862-1.88A7.333 7.333 0 0 0 24 10.167C24 5.654 20.18 2 15.333 2H9.5C4.82 2 1 5.654 1 10.167c0 2.027.78 3.867 2.05 5.293 1.613 1.813 3.952 3.02 5.495 3.874C11.142 20.809 13.53 22 16.072 22c2.094 0 3.35-.677 4.042-1.164a3.667 3.667 0 0 0 1.414-1.87c.132-.394-.035-.8-.416-.972a.8.8 0 0 0-.174-.064c-.388-.1-.773.101-.99.439-.35.544-.994 1.131-2.376 1.131-1.91 0-3.91-1.017-6.293-2.342-.99-.55-2.027-1.074-3.234-1.325z" />
    </svg>
  );
}

export function VertexAIIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 2L2 19.5h20L12 2z" fill="#4285F4" />
      <path d="M12 2L2 19.5h10V2z" fill="#669DF6" />
      <path d="M16 22a4 4 0 1 0 0-8 4 4 0 0 0 0 8z" fill="#AECBFA" />
    </svg>
  );
}

/** Mistral AI — official logomark from SimpleIcons */
export function MistralIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="0.6" y="0.6" width="5" height="5" fill="#F7D046" />
      <rect x="18.4" y="0.6" width="5" height="5" fill="#F7D046" />
      <rect x="0.6" y="6.4" width="5" height="5" fill="#F2A73B" />
      <rect x="9.5" y="6.4" width="5" height="5" fill="#F2A73B" />
      <rect x="18.4" y="6.4" width="5" height="5" fill="#F2A73B" />
      <rect x="0.6" y="12.2" width="5" height="5" fill="#EE792F" />
      <rect x="5.1" y="12.2" width="5" height="5" fill="#EE792F" />
      <rect x="9.5" y="12.2" width="5" height="5" fill="#EE792F" />
      <rect x="14" y="12.2" width="5" height="5" fill="#EE792F" />
      <rect x="18.4" y="12.2" width="5" height="5" fill="#EE792F" />
      <rect x="0.6" y="18" width="5" height="5" fill="#EB5829" />
      <rect x="18.4" y="18" width="5" height="5" fill="#EB5829" />
    </svg>
  );
}

/** Fireworks AI — official logomark from fireworks.ai */
export function FireworksIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 47.1 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M29.018.379 23.526 13.54 18.03.379h-3.527l6.025 14.386a3.22 3.22 0 0 0 2.978 1.976 3.22 3.22 0 0 0 2.978-1.97L32.545.378h-3.527ZM31.365 20.43l10.046-10.157-1.37-3.233-10.974 11.115a2.578 2.578 0 0 0-.672 3.501 2.578 2.578 0 0 0 2.973 1.96l15.685-.039-1.37-3.233-14.32.08h-.003ZM5.647 10.265l1.37-3.233L17.99 18.148a2.578 2.578 0 0 1-.672 3.5 2.578 2.578 0 0 1-2.973 1.96L.005 23.573l-.005.005 1.37-3.233 14.32.08L5.647 10.265Z"
        fill="#6720FF"
      />
    </svg>
  );
}

/** Together AI — based on official brand mark */
export function TogetherAIIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M5 4h14v2.5H13.25V20h-2.5V6.5H5V4Z" fill="#0F6FFF" />
      <circle cx="19" cy="20" r="2.5" fill="#0F6FFF" />
    </svg>
  );
}

/** Perplexity — official logomark from SimpleIcons */
export function PerplexityIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M22.398 7.09h-2.311V.068l-7.51 6.354V.158h-1.155v6.197L4.49 0v7.09H1.602v10.398h2.888V24l6.932-6.36v6.201h1.156v-6.047l6.932 6.18v-6.488h2.888V7.09zm-3.466-4.531v4.531h-5.355l5.355-4.531zm-13.286.068 4.869 4.463H5.646V2.626zM2.758 16.332V8.245h7.847l-6.115 6.115v1.972H2.758zm2.888 5.04v-3.885h.001v-2.649l5.776-5.776v7.011l-5.777 5.3zm12.709.025-5.777-5.151V9.062l5.777 5.777v6.559zm2.888-5.065h-1.733v-1.972l-6.115-6.115h7.848v8.087z" />
    </svg>
  );
}

/** DeepSeek — official brand logo */
export function DeepSeekIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        fill="#4D6BFE"
        d="M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 01-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 00-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 01-.465.137 9.597 9.597 0 00-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 001.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 011.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 01.415-.287.302.302 0 01.2.288.306.306 0 01-.31.307.303.303 0 01-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 01-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 01.016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 01-.254-.078c-.11-.054-.2-.19-.114-.358.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z"
      />
    </svg>
  );
}

/** xAI (Grok) — stylized X mark */
export function XAIIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z" />
    </svg>
  );
}

/** AWS Bedrock — official icon from staging assets */
export function BedrockIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <img
      src="/icons/models/aws-bedrock.svg"
      alt="AWS Bedrock"
      className={className}
      draggable={false}
    />
  );
}

export function UltravoxIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M2 3L12 21L16 13L22 3H16L12 11L8 3H2Z" fill="url(#ultravox-grad)" />
      <path d="M2 3L8 3L12 11L6 13L2 3Z" fill="url(#ultravox-shadow)" fillOpacity="0.3" />
      <defs>
        <linearGradient
          id="ultravox-grad"
          x1="2"
          y1="3"
          x2="16"
          y2="21"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#F4845F" />
          <stop offset="1" stopColor="#F43F5E" />
        </linearGradient>
        <linearGradient
          id="ultravox-shadow"
          x1="2"
          y1="3"
          x2="10"
          y2="15"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#000000" stopOpacity="0" />
          <stop offset="1" stopColor="#000000" stopOpacity="0.4" />
        </linearGradient>
      </defs>
    </svg>
  );
}

/** Fallback icon for unknown/custom providers */
export function CustomProviderIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x="3" y="3" width="18" height="18" rx="4" />
      <path d="M9 9h6M9 12h6M9 15h4" />
    </svg>
  );
}

/** Map provider ID → icon component */
export const PROVIDER_ICON_MAP: Record<string, React.ComponentType<IconProps>> = {
  openai: OpenAIIcon,
  anthropic: AnthropicIcon,
  azure: AzureIcon,
  microsoft_foundry_anthropic: AzureIcon,
  google: GoogleIcon,
  gemini: GeminiIcon,
  google_vertex: VertexAIIcon,
  groq: GroqIcon,
  cohere: CohereIcon,
  mistral: MistralIcon,
  fireworks: FireworksIcon,
  togetherai: TogetherAIIcon,
  perplexity: PerplexityIcon,
  deepseek: DeepSeekIcon,
  xai: XAIIcon,
  vertex_ai: VertexAIIcon,
  bedrock: BedrockIcon,
  ultravox: UltravoxIcon,
  custom: CustomProviderIcon,
};

/** Get the icon component for a given provider, with fallback */
export function getProviderIcon(providerId: string): React.ComponentType<IconProps> {
  return PROVIDER_ICON_MAP[providerId.toLowerCase()] || CustomProviderIcon;
}
