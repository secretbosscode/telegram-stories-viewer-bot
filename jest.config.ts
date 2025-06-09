import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  moduleNameMapper: {
    '^config/(.*)$': '<rootDir>/src/config/$1',
    '^controllers/(.*)$': '<rootDir>/src/controllers/$1',
    '^db/(.*)$': '<rootDir>/src/db/$1',
    '^db$': '<rootDir>/src/db/index.ts',
    '^services/(.*)$': '<rootDir>/src/services/$1',
    '^lib/(.*)$': '<rootDir>/src/lib/$1',
    '^lib$': '<rootDir>/src/lib/index.ts',
    '^repositories/(.*)$': '<rootDir>/src/repositories/$1',
    '^types$': '<rootDir>/src/types.ts',
    '^index$': '<rootDir>/src/index.ts',
    'p-limit': '<rootDir>/__mocks__/p-limit.js',
  },
};

export default config;
