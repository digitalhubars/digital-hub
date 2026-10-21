import { TriangleAlert } from 'lucide-react';
import Callout from '../../components/ui/Callout';
import { ui } from '../../styles/ui';

const Code = ({ children }) => <span className="font-mono text-xs">{children}</span>;

// Shown until the Supabase URL and publishable key are set (.env.local, or the Vercel project's environment variables).
export default function SetupNotice() {
  return (
    <div className="space-y-3 text-sm">
      <Callout icon={TriangleAlert} tone="warning">
        The Supabase project settings are missing.
      </Callout>
      <p className={ui.body}>
        Set <Code>NEXT_PUBLIC_SUPABASE_URL</Code> and <Code>NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY</Code> in <Code>.env.local</Code> (or in Vercel →
        Settings → Environment Variables), then restart or redeploy.
      </p>
    </div>
  );
}
