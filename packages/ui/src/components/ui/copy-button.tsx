"use client";

import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { cn } from "@/lib/utils";

interface CopyButtonProps {
  content: string;
  copyMessage?: string;
}

export function CopyButton({ content, copyMessage }: CopyButtonProps) {
  const { isCopied, handleCopy } = useCopyToClipboard({
    text: content,
    copyMessage,
  });

  return (
    <Button
      aria-label="Copy to clipboard"
      className="relative h-6 w-6"
      onClick={handleCopy}
      size="icon"
      variant="ghost"
    >
      <div className="absolute inset-0 flex items-center justify-center">
        <Icon
          className={cn(
            "h-4 w-4 transition-transform ease-in-out",
            isCopied ? "scale-100" : "scale-0"
          )}
          icon={Tick02Icon}
          size="sm"
        />
      </div>
      <Icon
        className={cn(
          "h-4 w-4 transition-transform ease-in-out",
          isCopied ? "scale-0" : "scale-100"
        )}
        icon={Copy01Icon}
        size="sm"
      />
    </Button>
  );
}
