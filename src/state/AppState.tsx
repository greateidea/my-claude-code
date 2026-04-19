import React, {
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  useEffectEvent,
} from 'react'
import { createStore } from './store.js'
import type { AppState, AppStateStore } from './AppStateStore.js'

export const AppStoreContext = React.createContext<AppStateStore | null>(null)

type Props = {
  children: React.ReactNode
  initialState?: AppState
  onChangeAppState?: (args: { newState: AppState; oldState: AppState }) => void
}

const HasAppStateContext = React.createContext<boolean>(false)

export function AppStateProvider({
  children,
  initialState,
  onChangeAppState,
}: Props): React.ReactNode {
  const hasAppStateContext = useContext(HasAppStateContext)
  if (hasAppStateContext) {
    throw new Error(
      'AppStateProvider can not be nested within another AppStateProvider'
    )
  }

  const [store] = useState(() =>
    createStore<AppState>(
      initialState ?? {
        messages: [],
        inputText: '',
        isLoading: false,
        error: null,
        sessionId: '',
        cwd: process.cwd(),
        model: 'claude-3-5-sonnet-20241022',
        toolPermissions: [],
        showSidebar: false,
        selectedMessageId: null,
      },
      onChangeAppState
    )
  )

  return (
    <HasAppStateContext.Provider value={true}>
      <AppStoreContext.Provider value={store}>
        {children}
      </AppStoreContext.Provider>
    </HasAppStateContext.Provider>
  )
}

function useAppStore(): AppStateStore {
  const store = useContext(AppStoreContext)
  if (!store) {
    throw new ReferenceError(
      'useAppState/useSetAppState cannot be called outside of an <AppStateProvider />'
    )
  }
  return store
}

export function useAppState<T>(selector: (state: AppState) => T): T {
  const store = useAppStore()
  
  return useSyncExternalStore(
    () => store.subscribe(() => {}),
    () => selector(store.getState()),
    () => selector(store.getState())
  )
}

export function useSetAppState() {
  const store = useAppStore()
  return store.setState
}