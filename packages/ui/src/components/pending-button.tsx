import { Button, type ButtonProps } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

/** A Button that shows a spinner and ignores clicks while its action runs. */
export function PendingButton({ pending, pendingLabel, children, disabled, ...props }: ButtonProps & { pending?: boolean; pendingLabel?: string }) {
  return (
    <Button {...props} disabled={disabled || pending} aria-busy={pending || undefined}>
      {pending && <Spinner size="xs" />}
      {pending && pendingLabel ? pendingLabel : children}
    </Button>
  );
}
