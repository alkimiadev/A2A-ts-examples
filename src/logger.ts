import { pino } from 'pino';

// Determine log level from environment variable, default to 'info'
const logLevel = process.env.A2A_LOG_LEVEL || 'info';

// Basic Pino configuration - explicitly write to stderr
const logger = pino(
  {
    level: logLevel,
    // Example: Add pretty printing if not in production
    ...(process.env.NODE_ENV !== 'production' && {
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname', // Optional: hide pid and hostname
          // pino-pretty defaults to stderr, but being explicit doesn't hurt
          destination: 2 // File descriptor 2 is stderr
        },
      },
    }),
  },
  pino.destination(2) // Explicitly set the destination stream to stderr (fd=2)
);

// Log the effective log level being used
logger.info(`Logger initialized with level: ${logger.level}`);

export default logger;