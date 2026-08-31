import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export default function Home() {
  return (
    <div className="flex flex-1 items-center justify-center bg-background p-8">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-center text-2xl">
            MSP PSA -- Foundation
          </CardTitle>
        </CardHeader>
        <CardContent className="flex justify-center">
          <Button disabled>Coming in Phase 2+</Button>
        </CardContent>
      </Card>
    </div>
  );
}
