import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function Home() {
  return (
    <div className="flex flex-col flex-1 items-center justify-center h-screen bg-zinc-50 font-sans dark:bg-black">
      <main className="flex flex-1 w-full max-w-3xl flex-col items-center justify-center py-32 px-16 text-center">
        <h1 className="text-4xl font-bold tracking-tight mb-4">
          Welcome to Taxidi
        </h1>
        <p className="text-lg text-muted-foreground mb-8">
          The collaborative workspace to plan your trips together. Let's explore the world.
        </p>
        <div className="flex gap-4">
          <Button asChild size="lg">
            <Link href="/dashboard">Go to Dashboard</Link>
          </Button>
          <Button asChild variant="outline" size="lg">
            <Link href="/sign-up">Get Started</Link>
          </Button>
        </div>
      </main>
    </div>
  );
}
