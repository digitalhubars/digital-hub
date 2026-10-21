import { TriangleAlert } from 'lucide-react';
import Callout from '../../components/ui/Callout';
import { ui } from '../../styles/ui';

const Code = ({ children }) => <span className="font-mono text-xs">{children}</span>;

// Shown until .env.local / .env.production has the Firebase web config.
export default function SetupNotice() {
  return (
    <div className="space-y-3 text-sm">
      <Callout icon={TriangleAlert} tone="warning">
        The Firebase project settings are missing.
      </Callout>
      <p className={ui.body}>
        Add the web app config to <Code>.env.local</Code> (see <Code>README.md</Code>, “Set up Firebase”), then restart the server.
      </p>
    </div>
  );
}
