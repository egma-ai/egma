/**
 * Which room this job runs in, which is the whole of what both verbs ask.
 *
 * Every room Egma conducts a simulation in is named `egma-sim-…`, and that
 * prefix is fixed and published. A room named anything else is a production
 * room, where `simulation()` returns having touched nothing and `monitor()`
 * does its work.
 *
 * The name is read off the job rather than from dispatch metadata because
 * dispatch metadata belongs to the customer, and because a room name arrives
 * on all three dispatch paths that can put an agent in an Egma room while
 * anything Egma writes into metadata arrives on only one of them.
 */
export const SIMULATION_ROOM_PREFIX = "egma-sim-";
