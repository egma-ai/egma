/**
 * The egma-sim- room prefix selects simulation behavior. Other rooms use monitoring.
 * Read the job room name because customer dispatch metadata is not a simulation
 * signal and is not present on every dispatch path.
 */
export const SIMULATION_ROOM_PREFIX = "egma-sim-";
