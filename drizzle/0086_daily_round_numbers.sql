-- Round numbers now start again from 1 every India day (services/greedy.ts, rocket.ts), so they repeat: drop uniqueness.
DROP INDEX "greedy_rounds_game_number";--> statement-breakpoint
DROP INDEX "rocket_rounds_number";