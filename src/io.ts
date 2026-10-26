import { Server } from "socket.io";

export const io = new Server();

export const roomChannel = (roomId: string) => `room:${roomId}`;
export const userChannel = (userId: string) => `user:${userId}`;

export const emitToRoom = (roomId: string, event: string, payload: unknown) => io.to(roomChannel(roomId)).emit(event, payload);
// Has the app open right now (any connected socket). shortcut: this server's sockets only; use the adapter's
// fetchSockets across nodes if the API ever runs on more than one.
export const isOnline = (userId: string) => (io.of("/").adapter.rooms.get(userChannel(userId))?.size ?? 0) > 0;
