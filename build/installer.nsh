; EditFlow assisted-installer branding.
; This file is included before electron-builder declares the NSIS pages.

!define MUI_ABORTWARNING
!define MUI_ABORTWARNING_TEXT "Deseja cancelar a instalação do EditFlow?"

!define MUI_WELCOMEPAGE_TITLE "Bem-vindo ao EditFlow"
!define MUI_WELCOMEPAGE_TEXT "Seu espaço de produção para organizar clientes, tarefas, prazos e entregas.$\r$\n$\r$\nEste assistente instalará o EditFlow no seu computador. Clique em Avançar para continuar."

!define MUI_FINISHPAGE_TITLE "EditFlow instalado com sucesso"
!define MUI_FINISHPAGE_TEXT "Tudo pronto. Entre na sua conta para sincronizar sua equipe e continuar sua produção."
!define MUI_FINISHPAGE_RUN_TEXT "Abrir EditFlow"

!define MUI_UNWELCOMEPAGE_TITLE "Desinstalar o EditFlow"
!define MUI_UNWELCOMEPAGE_TEXT "Este assistente removerá o EditFlow deste computador.$\r$\n$\r$\nSeus dados sincronizados permanecerão seguros na sua conta."
!define MUI_UNFINISHPAGE_TITLE "EditFlow removido"
!define MUI_UNFINISHPAGE_TEXT "O EditFlow foi removido deste computador."

!macro customWelcomePage
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customHeader
  BrandingText "EditFlow  •  Produção criativa organizada"
!macroend
