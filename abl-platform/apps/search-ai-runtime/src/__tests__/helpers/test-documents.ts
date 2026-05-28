/**
 * Test Documents for E2E Pipeline Tests
 *
 * Realistic document content across 4 domains for meaningful
 * vector search differentiation. Each ~800-1200 words to produce
 * 3-5 chunks with chunkSize: 256 tokens (~1024 chars).
 */

export interface TestDocumentDef {
  title: string;
  rawText: string;
  sourceMetadata: Record<string, unknown>;
}

// =============================================================================
// KUBERNETES GUIDE (~1000 words)
// =============================================================================

export const KUBERNETES_GUIDE: TestDocumentDef = {
  title: 'Kubernetes Container Orchestration Guide',
  sourceMetadata: {
    category: 'devops',
    product: 'kubernetes',
    difficulty: 'intermediate',
    price: 79.99,
  },
  rawText: `Kubernetes is the leading container orchestration platform, enabling teams to deploy, scale, and manage containerized applications across clusters of machines. Originally developed by Google and now maintained by the Cloud Native Computing Foundation, Kubernetes has become the de facto standard for running production workloads in the cloud.

At its core, Kubernetes organizes containers into logical units called Pods. A Pod is the smallest deployable unit and can contain one or more containers that share networking and storage resources. Pods are ephemeral by nature — they can be created, destroyed, and replaced at any time. This design encourages building stateless, resilient applications that can tolerate node failures without service interruption.

Deployments are higher-level abstractions that manage Pod lifecycle. When you create a Deployment, you specify the desired number of replicas and the container image to use. The Deployment controller continuously monitors the cluster state and ensures the actual number of running Pods matches the desired count. Rolling updates allow you to change the container image version gradually, replacing old Pods with new ones while maintaining availability. If something goes wrong during an update, Kubernetes can automatically roll back to the previous stable version.

Services provide stable network endpoints for accessing Pods. Since Pods have dynamic IP addresses that change when they restart, a Service assigns a persistent virtual IP and DNS name. ClusterIP services are only accessible within the cluster, NodePort services expose a port on every node, and LoadBalancer services integrate with cloud provider load balancers to expose applications to the internet. Ingress resources provide HTTP routing rules, allowing multiple services to share a single external IP address with path-based or host-based routing.

ConfigMaps and Secrets manage application configuration. ConfigMaps store non-sensitive key-value pairs that can be mounted as environment variables or files in Pod containers. Secrets are similar but base64-encoded and intended for sensitive data like passwords, API keys, and TLS certificates. Both can be updated independently of the application container image, enabling configuration changes without redeployment.

Namespaces provide logical isolation within a cluster. Teams can use separate namespaces for development, staging, and production environments, or to isolate different microservices. Resource quotas can be applied per namespace to limit CPU, memory, and storage consumption, preventing any single team from consuming all cluster resources. Network policies can restrict Pod-to-Pod communication across namespaces for additional security.

Horizontal Pod Autoscaling automatically adjusts the number of Pod replicas based on observed CPU utilization, memory usage, or custom metrics. When traffic increases, the autoscaler adds more Pods to handle the load. When traffic decreases, it removes excess Pods to conserve resources. The Cluster Autoscaler complements this by adding or removing worker nodes from the underlying infrastructure when the cluster needs more or less capacity.

Helm is the package manager for Kubernetes. Helm charts are pre-packaged collections of Kubernetes manifests that define an application and its dependencies. Charts can be versioned, shared through repositories, and customized using values files. This makes it easy to deploy complex applications like databases, monitoring stacks, and message queues with a single command. Helm also supports rollback, allowing you to revert to a previous release if a deployment causes issues.

Persistent Volumes and Persistent Volume Claims provide storage that outlives individual Pods. A Persistent Volume represents a piece of storage in the cluster, while a Persistent Volume Claim is a request for storage by a Pod. Storage classes define different tiers of storage with varying performance characteristics, such as SSD-backed fast storage or HDD-backed archival storage. StatefulSets manage Pods that require stable network identities and persistent storage, making them suitable for databases and other stateful applications.`,
};

// =============================================================================
// REACT HANDBOOK (~1000 words)
// =============================================================================

export const REACT_HANDBOOK: TestDocumentDef = {
  title: 'React Modern Development Handbook',
  sourceMetadata: {
    category: 'frontend',
    product: 'react',
    difficulty: 'intermediate',
    price: 59.99,
  },
  rawText: `React is a declarative JavaScript library for building user interfaces. Created by Facebook and maintained as an open-source project, React has revolutionized frontend development with its component-based architecture and virtual DOM rendering model. Modern React development relies heavily on functional components and hooks, replacing the older class-based approach.

Components are the fundamental building blocks of React applications. A component is a JavaScript function that accepts props as input and returns JSX elements describing what should appear on screen. JSX is a syntax extension that allows you to write HTML-like markup directly in JavaScript code. The React compiler transforms JSX into regular JavaScript function calls that create virtual DOM elements. Components can be composed together to build complex user interfaces from simple, reusable pieces.

The useState hook enables functional components to manage local state. When you call useState with an initial value, it returns the current state and a setter function. Each time the setter is called with a new value, React re-renders the component with the updated state. State updates are batched for performance — multiple setState calls within the same event handler result in a single re-render. The useReducer hook provides an alternative for complex state logic, using a reducer function that takes the current state and an action to produce the next state.

The useEffect hook handles side effects in functional components. Side effects include data fetching, DOM manipulation, subscriptions, and timers. useEffect accepts a callback function and an optional dependency array. The callback runs after render, and React tracks the dependencies to determine when the effect should re-execute. Returning a cleanup function from the effect allows you to cancel subscriptions or clear timers when the component unmounts or before the effect runs again. This pattern replaces the componentDidMount, componentDidUpdate, and componentWillUnmount lifecycle methods from class components.

Context provides a way to pass data through the component tree without manually threading props through every level. The createContext function creates a context object with a Provider component. Any descendant component can consume the context value using the useContext hook. This is particularly useful for global data like the current user, theme preferences, or locale settings. However, context should be used judiciously — excessive context providers can make components harder to test and reason about.

Custom hooks extract reusable stateful logic from components. A custom hook is simply a function whose name starts with use and that may call other hooks. For example, a useLocalStorage hook might combine useState with useEffect to synchronize state with the browser's localStorage. A useFetch hook might encapsulate the pattern of fetching data, tracking loading state, and handling errors. Custom hooks promote code reuse without the complexity of higher-order components or render props.

React's reconciliation algorithm efficiently updates the DOM by comparing the previous and current virtual DOM trees. When state or props change, React creates a new virtual DOM tree, diffs it against the previous one, and applies only the minimum set of DOM mutations needed. Keys help React identify which elements in a list have changed, been added, or been removed, enabling efficient list rendering without unnecessary re-creation of DOM nodes.

The useMemo and useCallback hooks optimize performance by memoizing expensive computations and callback references. useMemo caches the result of a computation and only recalculates when its dependencies change. useCallback returns a memoized callback function that only changes when its dependencies change. These hooks are particularly important when passing callbacks to child components wrapped in React.memo, which skips re-rendering when props are shallowly equal.

Error boundaries catch JavaScript errors anywhere in the component tree and display fallback UI instead of crashing the entire application. While error boundaries are currently only available as class components, they can wrap functional components to provide graceful error handling. Combined with React Suspense for code splitting and data fetching, error boundaries create a robust error handling strategy for production applications.`,
};

// =============================================================================
// POSTGRESQL ADMIN (~1000 words)
// =============================================================================

export const POSTGRESQL_ADMIN: TestDocumentDef = {
  title: 'PostgreSQL Database Administration',
  sourceMetadata: {
    category: 'database',
    product: 'postgresql',
    difficulty: 'advanced',
    price: 99.99,
  },
  rawText: `PostgreSQL is a powerful open-source relational database management system known for its reliability, feature richness, and standards compliance. With over 35 years of active development, PostgreSQL supports advanced data types, full-text search, JSON operations, and extensibility through custom functions and extensions.

Query optimization is fundamental to PostgreSQL performance. The query planner analyzes SQL statements and generates execution plans that minimize resource consumption. The EXPLAIN command reveals the planner's chosen strategy, showing sequential scans, index scans, hash joins, merge joins, and nested loop joins. EXPLAIN ANALYZE executes the query and shows actual timing data alongside the estimates. Understanding execution plans is essential for identifying slow queries and determining where indexes would be beneficial.

B-tree indexes are the default and most common index type in PostgreSQL. They support equality and range queries on ordered data types. Composite indexes cover multiple columns and can satisfy queries that filter or sort on any prefix of the indexed columns. Partial indexes only index rows matching a WHERE clause, reducing index size and maintenance overhead for frequently queried subsets. Expression indexes index the result of a function or expression, enabling efficient lookups on computed values like lower(email) for case-insensitive searches.

GIN (Generalized Inverted Index) indexes are designed for composite values like arrays, JSONB documents, and full-text search vectors. A GIN index maps each element or key within the composite value to the rows containing it. This makes containment queries extremely fast — for example, finding all rows where a JSONB column contains a specific key-value pair. GiST (Generalized Search Tree) indexes support geometric data, range types, and full-text search with different trade-offs than GIN indexes, offering faster updates at the cost of slightly slower lookups.

Connection pooling is critical for production PostgreSQL deployments. Each PostgreSQL connection spawns a separate server process with its own memory allocation, making hundreds of simultaneous connections expensive. PgBouncer is a lightweight connection pooler that sits between the application and PostgreSQL, maintaining a pool of reusable connections. It supports transaction pooling, where connections are returned to the pool after each transaction, and session pooling, where connections persist for the entire client session.

VACUUM is PostgreSQL's garbage collection mechanism. Due to MVCC (Multi-Version Concurrency Control), UPDATE and DELETE operations create dead tuples rather than modifying rows in place. VACUUM reclaims storage occupied by dead tuples and updates the visibility map and free space map. Autovacuum runs in the background and triggers based on configurable thresholds. If autovacuum cannot keep up with write-heavy workloads, table bloat increases and query performance degrades. Monitoring pg_stat_user_tables reveals tables with high dead tuple counts that may need manual VACUUM or autovacuum tuning.

Replication in PostgreSQL provides high availability and read scalability. Streaming replication continuously ships WAL (Write-Ahead Log) records from the primary server to one or more standby servers. Synchronous replication guarantees that transactions are committed on at least one standby before acknowledging the client, preventing data loss during failover. Asynchronous replication offers better performance but risks losing recent transactions if the primary fails. Logical replication selectively replicates specific tables or schemas, enabling migration, data distribution, and multi-master configurations.

Partitioning divides large tables into smaller physical pieces while maintaining a single logical table interface. Range partitioning splits data by value ranges, such as monthly date ranges for time-series data. List partitioning assigns rows to partitions based on discrete values, like country or region. Hash partitioning distributes rows evenly across partitions using a hash function. Partition pruning allows the query planner to skip irrelevant partitions, dramatically improving query performance on large datasets.

Backup and recovery strategies protect against data loss. pg_dump creates logical backups of individual databases or tables, producing SQL scripts or custom-format archives that can be selectively restored. pg_basebackup creates physical backups of the entire cluster, suitable for point-in-time recovery when combined with archived WAL segments. Continuous archiving with WAL shipping enables recovery to any point in time, providing protection against accidental data deletion or corruption.`,
};

// =============================================================================
// MONGODB BASICS (~900 words)
// =============================================================================

export const MONGODB_BASICS: TestDocumentDef = {
  title: 'MongoDB Fundamentals and Best Practices',
  sourceMetadata: {
    category: 'database',
    product: 'mongodb',
    difficulty: 'beginner',
    price: 39.99,
  },
  rawText: `MongoDB is a document-oriented NoSQL database designed for flexibility, scalability, and developer productivity. Unlike traditional relational databases that store data in rows and columns, MongoDB stores data as flexible JSON-like documents in collections. This schema-flexible approach allows developers to iterate quickly and handle data with varying structures without requiring upfront schema definitions.

Documents are the basic unit of data in MongoDB. Each document is a BSON (Binary JSON) object that can contain nested objects, arrays, and various data types including strings, numbers, dates, binary data, and ObjectIds. Documents in the same collection can have different fields, making MongoDB well-suited for applications where data structures evolve over time. The maximum document size is 16 megabytes, which accommodates most use cases while preventing excessively large documents that could impact performance.

Collections group related documents together, similar to tables in relational databases. However, collections do not enforce a fixed schema by default. MongoDB provides schema validation rules that can optionally enforce document structure using JSON Schema syntax. Validation rules can require specific fields, constrain data types, and define allowed value ranges. This gives teams the flexibility to start without strict schemas and add validation as requirements stabilize.

The aggregation framework is MongoDB's most powerful data processing tool. Aggregation pipelines consist of stages that transform documents as they pass through. The $match stage filters documents like a WHERE clause. The $group stage performs grouping and accumulation operations like SUM, AVG, COUNT, MIN, and MAX. The $project stage reshapes documents by including, excluding, or computing new fields. The $lookup stage performs left outer joins between collections, enabling relational-style queries across document boundaries. The $unwind stage deconstructs arrays into individual documents for per-element processing.

Indexes dramatically improve query performance in MongoDB. Without an index, MongoDB must scan every document in a collection to find matches. Single-field indexes support queries on one field. Compound indexes cover multiple fields and support queries that match any prefix of the indexed fields. Multikey indexes automatically index array elements, enabling efficient queries on array contents. Text indexes support full-text search with language-aware stemming and stop word removal. Geospatial indexes enable location-based queries using 2dsphere or 2d index types.

The find method is the primary way to query documents in MongoDB. Query filters use operators like $eq, $gt, $lt, $in, $regex, and $exists to match documents. Projection controls which fields are included in results, reducing network transfer and memory usage. The sort method orders results, and limit and skip enable pagination. For complex queries, the aggregation framework provides more flexibility than simple find operations.

Write operations in MongoDB include insertOne, insertMany, updateOne, updateMany, replaceOne, deleteOne, and deleteMany. Update operators like $set, $unset, $inc, $push, $pull, and $addToSet modify specific fields without replacing entire documents. Bulk write operations combine multiple operations into a single request, reducing network round trips. Write concern controls the level of acknowledgment requested from MongoDB, trading durability guarantees for write performance.

Replica sets provide high availability and data redundancy. A replica set consists of a primary node that receives all writes and one or more secondary nodes that replicate data from the primary. If the primary becomes unavailable, an election automatically promotes a secondary to primary. Read preference settings allow applications to read from secondaries for better read scalability, with options like primaryPreferred, secondary, secondaryPreferred, and nearest.

Sharding distributes data across multiple servers for horizontal scalability. A shard key determines how documents are distributed across shards. Range-based sharding assigns contiguous ranges of the shard key to different shards, while hashed sharding distributes documents more evenly using a hash of the shard key. Choosing an appropriate shard key is critical — a poor choice can lead to unbalanced data distribution and hot spots where one shard receives disproportionate traffic. The mongos router directs queries to the appropriate shards based on the shard key in the query filter.`,
};

// =============================================================================
// ALL DOCUMENTS (convenience array)
// =============================================================================

export const ALL_TEST_DOCUMENTS: TestDocumentDef[] = [
  KUBERNETES_GUIDE,
  REACT_HANDBOOK,
  POSTGRESQL_ADMIN,
  MONGODB_BASICS,
];
