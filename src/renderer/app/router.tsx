import { Workspace } from '@renderer/features/workspace/Workspace'
import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter
} from '@tanstack/react-router'
import { RootLayout } from './RootLayout'

const rootRoute = createRootRoute({ component: RootLayout })

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: Workspace
})

const routeTree = rootRoute.addChildren([indexRoute])

export const router = createRouter({
  routeTree,
  history: createHashHistory()
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
