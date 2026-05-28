employee experience application wanting to build the followign capabilties using hte platform

- a universal orchesrator that is intelligent, can manage state of the conversation wtih teh user
- chat SDK on the ex application will point to the universal orchestrator
- Universal orchestrator is exposed as chatgpt like interface
- ex application carries the user indetify authenticated via single signon
- ex application has the sync with active directory
- ex app requires capability called department workspaces
- department workspaces have membership of users, user groups as well has modules or agents
- teh agents or modules are all consumed via universal orchesrator agent
- departments can have retricted list of agents available from teh agents or moduels from the tenant registry
- when a user interacts wiht the universal orchestrator as authenticated user - we should be able to find the approprate modules that he/she has visibility into
- the orchestrator should be able to do routing to those agents
- the orchestrator can have settings but those routing settings or rules
- only one routing profile to begin with; later we could possbly add multiple routing profiles and give an option for the user to choose or switch routing profile based on the context of the conversation
- the history is mostly tracked against the orchestrator but with details on how each of the child agents served the requests
- enterprise should be abel to edit agent/module registry against the enteprirse department workspace, and see observability, analystics against both orchestrator and child agents
